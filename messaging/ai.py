import frappe
from frappe import _
from frappe.utils.password import get_decrypted_password

try:
	import requests
except ImportError:
	requests = None


DEFAULT_SYSTEM_PROMPT = (
	"You are an AI assistant embedded in a company's internal business messaging app. "
	"Be concise, factual, and professional. Base your answers only on the context you are "
	"given. If you are not sure about something, say so rather than guessing."
)

# Maps a feature key (used by feature-level whitelisted endpoints) to the
# corresponding Check field on the Chat Settings singleton. Extend this as
# Phase 2+ features are added rather than hardcoding checks elsewhere.
FEATURE_FIELD_MAP = {
	"ask_this_chat": "enable_ask_this_chat",
	"conversation_summary": "enable_conversation_summary",
	"catch_me_up": "enable_catch_me_up",
	"reply_assistant": "enable_reply_assistant",
	"action_items": "enable_action_items",
	"chat_search": "enable_chat_search",
}


class AIProviderError(Exception):
	"""Raised when the AI provider responds with a non-2xx status or an unusable body."""


# ----------------------------------------------------------------------
# SETTINGS HELPERS
# ----------------------------------------------------------------------

def get_ai_settings():
	return frappe.get_single("Chat Settings")


def get_api_key():
	"""Return the decrypted API key, or None if unset."""
	try:
		return get_decrypted_password("Chat Settings", "Chat Settings", "api_key", raise_exception=False)
	except Exception:
		return None


def is_ai_enabled():
	"""Master switch check — independent of any individual feature toggle."""
	return bool(get_ai_settings().enabled)


def is_feature_enabled(feature_key: str):
	"""Check both the master switch and the specific feature's toggle."""
	settings = get_ai_settings()

	if not settings.enabled:
		return False

	fieldname = FEATURE_FIELD_MAP.get(feature_key)
	if not fieldname:
		return False

	return bool(settings.get(fieldname))


def require_feature_enabled(feature_key: str):
	"""Throw a user-facing error if a feature isn't enabled. Call this at the top
	of every feature-level whitelisted endpoint before doing any work."""
	if not is_feature_enabled(feature_key):
		frappe.throw(_("This AI feature is not enabled. Ask a System Manager to turn it on in Chat Settings."))


# ----------------------------------------------------------------------
# CORE COMPLETION CALL
# ----------------------------------------------------------------------

def get_ai_completion(messages, system_prompt: str = None, max_tokens: int = None, temperature: float = None):
	"""Send a chat-style request to whichever provider is configured in Chat Settings
	and return the reply text. This does NOT check feature flags or the master
	switch — callers (feature endpoints) are responsible for calling
	require_feature_enabled()/is_feature_enabled() first. This function only
	validates that the provider itself is configured well enough to call.

	messages: list of {"role": "user"|"assistant", "content": str}, oldest first.
	"""
	if requests is None:
		frappe.throw(_("The 'requests' library is not available on this site."))

	settings = get_ai_settings()

	platform = settings.platform
	if not platform:
		frappe.throw(_("No AI platform is configured in Chat Settings."))

	model = settings.model
	if not model:
		frappe.throw(_("No AI model is configured in Chat Settings."))

	api_key = get_api_key()
	if not api_key:
		frappe.throw(_("No AI API key is configured in Chat Settings."))

	if not messages:
		frappe.throw(_("No messages were provided to the AI."))

	resolved_system_prompt = system_prompt or settings.system_prompt or DEFAULT_SYSTEM_PROMPT
	resolved_max_tokens = max_tokens or frappe.utils.cint(settings.max_tokens) or 800
	resolved_temperature = (
		temperature if temperature is not None
		else (frappe.utils.flt(settings.temperature) if settings.temperature not in (None, "") else 0.4)
	)

	dispatch = {
		"ChatGPT": _call_openai,
		"Gemini": _call_gemini,
		"Claude": _call_claude,
	}

	handler = dispatch.get(platform)
	if not handler:
		frappe.throw(_("Unsupported AI platform: {0}").format(platform))

	try:
		reply = handler(api_key, model, messages, resolved_system_prompt, resolved_max_tokens, resolved_temperature)
	except AIProviderError as e:
		frappe.log_error(title="AI Provider Error", message=f"{platform} / {model}: {e}")
		frappe.throw(_("The AI provider returned an error: {0}").format(str(e)))
	except requests.exceptions.RequestException:
		frappe.log_error(title="AI Request Failed", message=frappe.get_traceback())
		frappe.throw(_("Could not reach the AI provider. Please try again shortly."))

	if not reply:
		frappe.throw(_("The AI provider returned an empty response."))

	return reply


# ----------------------------------------------------------------------
# PROVIDER ADAPTERS
# Each adapter takes the same inputs and returns a plain string reply.
# Keeping the wire format differences isolated here is the whole point of
# this file: every feature above only ever talks to get_ai_completion().
# ----------------------------------------------------------------------

def _call_openai(api_key, model, messages, system_prompt, max_tokens, temperature):
	payload_messages = []
	if system_prompt:
		payload_messages.append({"role": "system", "content": system_prompt})
	for m in messages:
		payload_messages.append({"role": m.get("role") or "user", "content": m.get("content") or ""})

	resp = requests.post(
		"https://api.openai.com/v1/chat/completions",
		headers={
			"Authorization": f"Bearer {api_key}",
			"Content-Type": "application/json",
		},
		json={
			"model": model,
			"messages": payload_messages,
			"max_tokens": max_tokens,
			"temperature": temperature,
		},
		timeout=30,
	)

	if resp.status_code != 200:
		raise AIProviderError(_extract_error_message(resp))

	data = resp.json()
	choices = data.get("choices") or []
	if not choices:
		raise AIProviderError("Empty response from ChatGPT")

	return ((choices[0].get("message") or {}).get("content") or "").strip()


def _call_claude(api_key, model, messages, system_prompt, max_tokens, temperature):
	payload_messages = [
		{"role": m.get("role") or "user", "content": m.get("content") or ""} for m in messages
	]

	resp = requests.post(
		"https://api.anthropic.com/v1/messages",
		headers={
			"x-api-key": api_key,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		json={
			"model": model,
			"system": system_prompt,
			"messages": payload_messages,
			"max_tokens": max_tokens,
			"temperature": temperature,
		},
		timeout=30,
	)

	if resp.status_code != 200:
		raise AIProviderError(_extract_error_message(resp))

	data = resp.json()
	content_blocks = data.get("content") or []
	text_parts = [b.get("text", "") for b in content_blocks if b.get("type") == "text"]

	if not text_parts:
		raise AIProviderError("Empty response from Claude")

	return "".join(text_parts).strip()


def _call_gemini(api_key, model, messages, system_prompt, max_tokens, temperature):
	contents = []
	for m in messages:
		role = "model" if m.get("role") == "assistant" else "user"
		contents.append({"role": role, "parts": [{"text": m.get("content") or ""}]})

	payload = {
		"contents": contents,
		"generationConfig": {
			"maxOutputTokens": max_tokens,
			"temperature": temperature,
		},
	}
	if system_prompt:
		payload["systemInstruction"] = {"parts": [{"text": system_prompt}]}

	resp = requests.post(
		f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
		params={"key": api_key},
		headers={"Content-Type": "application/json"},
		json=payload,
		timeout=30,
	)

	if resp.status_code != 200:
		raise AIProviderError(_extract_error_message(resp))

	data = resp.json()
	candidates = data.get("candidates") or []
	if not candidates:
		raise AIProviderError("Empty response from Gemini")

	parts = ((candidates[0].get("content") or {}).get("parts")) or []
	text = "".join(p.get("text", "") for p in parts).strip()

	if not text:
		raise AIProviderError("Empty response from Gemini")

	return text


def _extract_error_message(resp):
	"""Best-effort extraction of a human-readable error across providers'
	differing error body shapes."""
	try:
		data = resp.json()
	except ValueError:
		return f"HTTP {resp.status_code}"

	if isinstance(data, dict):
		err = data.get("error")
		if isinstance(err, dict):
			return err.get("message") or str(err)
		if isinstance(err, str):
			return err

	return f"HTTP {resp.status_code}"


# ----------------------------------------------------------------------
# ADMIN UTILITY
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_ai_feature_flags():
	"""Return which AI features are currently enabled, for the client to decide
	what UI to show. Safe to call by any logged-in user — reveals only on/off
	state, never platform/model/API key."""
	settings = get_ai_settings()

	if not settings.enabled:
		return {key: False for key in FEATURE_FIELD_MAP}

	return {key: bool(settings.get(fieldname)) for key, fieldname in FEATURE_FIELD_MAP.items()}


@frappe.whitelist()
def test_ai_connection():
	"""Make a tiny live call to verify the configured platform/model/key actually
	work together. Bypasses feature flags on purpose — this is for validating
	setup before any feature is turned on."""
	if "System Manager" not in frappe.get_roles():
		frappe.throw(_("Only System Managers can test the AI connection"))

	settings = get_ai_settings()

	if not settings.platform:
		frappe.throw(_("Select an AI platform first."))
	if not settings.model:
		frappe.throw(_("Enter a model name first."))
	if not get_api_key():
		frappe.throw(_("Enter an API key first."))

	reply = get_ai_completion(
		messages=[{"role": "user", "content": "Reply with the single word: OK"}],
		system_prompt="You are a connection test. Reply with exactly one word and nothing else.",
		max_tokens=10,
		temperature=0,
	)

	return {"ok": True, "reply": reply}