import frappe
from frappe import _

from messaging.ai import get_ai_completion, require_feature_enabled
from messaging.ai_features import get_thread_transcript, _build_system_prompt, _parse_json_response


# ----------------------------------------------------------------------
# PERMISSION-CHECKED, DOCTYPE-AGNOSTIC ENTITY LOOKUP
#
# Two design rules from the concept doc, both non-negotiable:
#   1. AI must never bypass Frappe permissions — every read here goes through
#      frappe.has_permission() for the CURRENT user. If they couldn't see it
#      through the normal desk UI, the AI can't see it either.
#   2. AI suggests, the user confirms, THEN the AI acts. detect_business_entities
#      only ever surfaces candidates — it never fetches full record details.
#      get_entity_details is a separate, explicit second call the user
#      triggers by tapping a specific suggestion.
#
# Detection is NOT hardcoded to Customer/Sales Invoice. It searches Frappe's
# own Global Search index, which spans every doctype a site has enabled for
# search (Settings > Global Search Settings) — on a typical ERPNext install
# that's easily hundreds of doctypes, without us hardcoding any of them.
# ----------------------------------------------------------------------

DETECT_ENTITY_INSTRUCTIONS = (
	"You will be given a chat transcript between colleagues discussing work. Identify up to 3 "
	"distinct proper nouns that could refer to a specific record somewhere in the company's "
	"system — e.g. a company/customer/supplier name, a project name, an item or product name, "
	"an order or invoice number, an employee name. Do not assume what type of record it is, and "
	"do not assume it's necessarily a customer.\n\n"
	"Respond with ONLY valid JSON (no markdown, no code fences) matching exactly this shape:\n"
	'{"candidates": ["name 1", "name 2"]}\n\n'
	"Only include names that are clearly specific and could plausibly be looked up as a real "
	"record — not generic words like 'the order' or 'that project'. Return an empty array if "
	"nothing in the transcript qualifies."
)


def _extract_candidate_names(transcript: str):
	"""Ask the AI for a few free-text candidate names — not tied to any
	doctype. This is deliberately cheap (small max_tokens, temperature 0) since
	it's just a hint for the search step, not the source of truth."""
	if not transcript:
		return []

	system_prompt = _build_system_prompt(DETECT_ENTITY_INSTRUCTIONS)

	raw = get_ai_completion(
		messages=[{"role": "user", "content": f"Transcript:\n{transcript}"}],
		system_prompt=system_prompt,
		max_tokens=150,
		temperature=0,
	)

	parsed = _parse_json_response(raw) or {}
	candidates = parsed.get("candidates") or []
	return [c.strip() for c in candidates if isinstance(c, str) and c.strip()][:3]


def _search_records(term: str, limit: int = 5):
	"""Search across every doctype indexed in Frappe's Global Search — the
	same mechanism behind the Awesomebar. This is what makes 'any of the
	800+ tables' actually work without us hand-listing doctypes: whatever a
	site admin has enabled under Global Search Settings is automatically
	covered. Falls back to an empty result (not an error) if the site's
	search index isn't built yet, so this feature degrades gracefully rather
	than breaking."""
	if not term:
		return []

	try:
		from frappe.utils.global_search import search as global_search

		results = global_search(term, start=0, limit=limit) or []
	except Exception:
		frappe.log_error(title="AI Entity Search: global_search failed", message=frappe.get_traceback())
		results = []

	matches = []
	for r in results:
		doctype = r.get("doctype")
		name = r.get("name")
		if not doctype or not name:
			continue

		# Belt-and-suspenders: re-verify permission ourselves even though
		# global_search is expected to already respect it. Never trust a
		# single layer for something this important.
		if not frappe.has_permission(doctype, "read", doc=name):
			continue

		matches.append(
			{
				"doctype": doctype,
				"name": name,
				"title": (r.get("content") or name)[:120],
			}
		)

	return matches


@frappe.whitelist()
def detect_business_entities(user: str = None, group: str = None):
	"""Step 1 of the confirm-before-fetch flow: look at a conversation and
	surface real records (of ANY doctype) that might be worth pulling details
	on — without fetching full details yet. Returns suggestions only."""
	require_feature_enabled("entity_lookup")

	if not user and not group:
		frappe.throw(_("No conversation was specified."))

	transcript, message_count = get_thread_transcript(user=user, group=group, limit=100)
	if not message_count:
		return {"matches": []}

	candidates = _extract_candidate_names(transcript)
	if not candidates:
		return {"matches": []}

	seen = set()
	matches = []
	for candidate in candidates:
		for m in _search_records(candidate):
			key = (m["doctype"], m["name"])
			if key in seen:
				continue
			seen.add(key)
			matches.append(m)

	return {"matches": matches[:6]}


@frappe.whitelist()
def get_entity_details(doctype: str, name: str):
	"""Step 2: the user tapped a specific suggestion and confirmed they want
	details. Fetches a generic summary for ANY doctype, with a richer
	enrichment layered on top for a few well-known doctypes (Customer today;
	Sales Order / Purchase Order / Project can be added the same way later)."""
	require_feature_enabled("entity_lookup")

	if not doctype or not name:
		frappe.throw(_("A doctype and record name are required."))

	if not frappe.db.exists("DocType", doctype):
		frappe.throw(_("Unknown doctype."))

	if not frappe.db.exists(doctype, name):
		frappe.throw(_("Record not found."))

	if not frappe.has_permission(doctype, "read", doc=name):
		frappe.throw(_("You don't have permission to view this record."))

	if doctype == "Customer":
		result = _get_customer_financials(name)
		result["doctype"] = doctype
		result["kind"] = "customer"
		return result

	return _get_generic_summary(doctype, name)


def _get_generic_summary(doctype: str, name: str):
	"""Doctype-agnostic summary: a title, a handful of interesting fields
	(status/date/currency-type fields the doctype's own meta exposes), and
	enough info for the client to link back into the desk. This is the part
	that makes every other doctype usable without a bespoke card for each."""
	meta = frappe.get_meta(doctype)
	doc = frappe.get_doc(doctype, name)

	title_field = getattr(meta, "title_field", None)
	title = doc.get(title_field) if title_field and title_field != "name" else None

	highlight_fields = []
	for df in meta.fields:
		if not df.fieldname:
			continue
		if df.fieldtype not in ("Currency", "Date", "Datetime", "Select"):
			continue
		if df.fieldtype == "Select" and df.fieldname not in ("status", "workflow_state"):
			continue

		value = doc.get(df.fieldname)
		if value in (None, ""):
			continue

		highlight_fields.append({"label": df.label or df.fieldname, "value": str(value)})
		if len(highlight_fields) >= 6:
			break

	return {
		"doctype": doctype,
		"kind": "generic",
		"name": name,
		"title": title or name,
		"fields": highlight_fields,
	}


def _get_customer_financials(customer_name: str):
	"""Pull a financial snapshot for a Customer — outstanding, overdue, open
	invoice count, latest payment. Each section is independently gated on the
	current user's permission for that doctype; a user without Sales Invoice
	access simply gets that section left at zero, never a permission bypass."""
	result = {
		"customer": customer_name,
		"customer_display_name": frappe.db.get_value("Customer", customer_name, "customer_name") or customer_name,
		"outstanding": 0,
		"overdue": 0,
		"open_invoice_count": 0,
		"last_payment_amount": None,
		"last_payment_date": None,
		"currency": frappe.defaults.get_global_default("currency") or "",
	}

	if frappe.db.exists("DocType", "Sales Invoice") and frappe.has_permission("Sales Invoice", "read"):
		invoices = frappe.get_all(
			"Sales Invoice",
			filters={"customer": customer_name, "docstatus": 1, "outstanding_amount": [">", 0]},
			fields=["name", "outstanding_amount", "due_date"],
		)
		result["open_invoice_count"] = len(invoices)
		result["outstanding"] = sum(inv.outstanding_amount for inv in invoices)

		today = frappe.utils.today()
		result["overdue"] = sum(
			inv.outstanding_amount for inv in invoices
			if inv.due_date and str(inv.due_date) < today
		)

	if frappe.db.exists("DocType", "Payment Entry") and frappe.has_permission("Payment Entry", "read"):
		last_payment = frappe.get_all(
			"Payment Entry",
			filters={"party_type": "Customer", "party": customer_name, "docstatus": 1},
			fields=["paid_amount", "posting_date"],
			order_by="posting_date desc",
			limit=1,
		)
		if last_payment:
			result["last_payment_amount"] = last_payment[0].paid_amount
			result["last_payment_date"] = str(last_payment[0].posting_date)

	return result