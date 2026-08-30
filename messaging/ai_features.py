
import json
import re

import frappe
from frappe import _

from messaging.api import NOTIFICATION_BOT_USER, get_chat_user_details, is_group_member
from messaging.ai import get_ai_completion, get_ai_settings, require_feature_enabled, DEFAULT_SYSTEM_PROMPT


# ----------------------------------------------------------------------
# SHARED HELPERS
# Every Phase 1 feature that reasons about a conversation (Ask This Chat,
# Conversation Summary, Catch Me Up, ...) needs the same thing: a permission
# checked, nicely formatted transcript of that conversation. Built once here.
# ----------------------------------------------------------------------

def _build_system_prompt(feature_instructions: str):
   """Combine the admin-configured global system prompt with feature-specific
   instructions, so tone/persona stays consistent across every AI feature."""
   settings = get_ai_settings()
   base = settings.system_prompt or DEFAULT_SYSTEM_PROMPT
   return f"{base}\n\n{feature_instructions}"


def _parse_json_response(raw: str):
   """Best-effort parse of a JSON object the model was asked to return. Models
   sometimes wrap JSON in markdown code fences despite instructions not to —
   strip those before parsing. Returns None if parsing fails entirely, so
   callers can fall back to showing the raw text instead of erroring out."""
   if not raw:
       return None

   text = raw.strip()
   if text.startswith("```"):
       text = text.strip("`")
       if text.lower().startswith("json"):
           text = text[4:]
       text = text.strip()

   try:
       return json.loads(text)
   except (ValueError, TypeError):
       return None


def get_thread_transcript(user: str = None, group: str = None, limit: int = 200):
   """Fetch and format a chat transcript for use as AI context. Exactly one of
   `user` (direct chat with that user) or `group` should be given. Enforces
   the same access checks as the regular message-fetching endpoints, so the
   AI never sees a conversation the caller couldn't otherwise read.  Returns (transcript_text, message_count). Attachment-only messages are skipped for now — only text content is included in the transcript. """
   current_user = frappe.session.user

   if group:
       if not frappe.db.exists("Chat Group", group):
           frappe.throw(_("Group not found"))
       if not is_group_member(group, current_user):
           frappe.throw(_("You are not a member of this group"))

       rows = frappe.db.sql(
           """
           SELECT from_user, message, creation
           FROM `tabChat Log`
           WHERE `group` = %(group)s
           ORDER BY creation DESC
           LIMIT %(limit)s
           """,
           {"group": group, "limit": limit},
           as_dict=True,
       )
   elif user:
       if user != NOTIFICATION_BOT_USER and not frappe.db.exists("Chat User",
user):
           frappe.throw(_("Chat User not found: {0}").format(user))

       rows = frappe.db.sql(
           """
           SELECT from_user, message, creation
           FROM `tabChat Log`
           WHERE (from_user = %(current_user)s AND to_user = %(other_user)s)
              OR (from_user = %(other_user)s AND to_user = %(current_user)s)
           ORDER BY creation DESC
           LIMIT %(limit)s
           """,
           {"current_user": current_user, "other_user": user, "limit": limit},
           as_dict=True,
       )
   else:
       frappe.throw(_("Either user or group must be provided"))

   rows.reverse()  # rows came back newest-first for the LIMIT; put them in
                                                                           # chronological order

   if not rows:
       return "", 0

   details_cache = {}
   lines = []

   for row in rows:
       text = (row.message or "").strip()
       if not text:
           continue  # skip attachment-only messages — text context only, for now

       sender = row.from_user
       if sender not in details_cache:
           details_cache[sender] = get_chat_user_details(sender)
       details = details_cache[sender]
       name = details["full_name"] if details else sender

       timestamp = frappe.utils.get_datetime(row.creation).strftime("%b %d, %H:%M")
       lines.append(f"[{timestamp}] {name}: {text}")

   return "\n".join(lines), len(lines)


def get_unread_transcript(user: str = None, group: str = None, limit: int = 300):
   """Same idea as get_thread_transcript, but scoped to only the messages the
   current user hasn't seen yet — what Catch Me Up should actually reason about, not the full history. Only includes messages from other people; your own messages were never "missed"."""
   current_user = frappe.session.user

   if group:
       if not frappe.db.exists("Chat Group", group):
           frappe.throw(_("Group not found"))
       if not is_group_member(group, current_user):
           frappe.throw(_("You are not a member of this group"))

       last_seen = frappe.db.get_value(
           "Chat Group User",
           {"parent": group, "parenttype": "Chat Group", "user": current_user},
           "last_seen",
       )

       conditions = "WHERE `group` = %(group)s AND from_user != %(user)s"
       values = {"group": group, "user": current_user, "limit": limit}
       if last_seen:
           conditions += " AND creation > %(last_seen)s"
           values["last_seen"] = last_seen

       rows = frappe.db.sql(
           f"""
           SELECT from_user, message, creation
           FROM `tabChat Log`
           {conditions}
           ORDER BY creation ASC
           LIMIT %(limit)s
           """,
           values,
           as_dict=True,
       )
   elif user:
       if user != NOTIFICATION_BOT_USER and not frappe.db.exists("Chat User",
user):
           frappe.throw(_("Chat User not found: {0}").format(user))

       rows = frappe.db.sql(
           """
           SELECT from_user, message, creation
           FROM `tabChat Log`
           WHERE from_user = %(other_user)s AND to_user = %(current_user)s AND seen
= 0
           ORDER BY creation ASC
           LIMIT %(limit)s
           """,
           {"other_user": user, "current_user": current_user, "limit": limit},
           as_dict=True,
       )
   else:
       frappe.throw(_("Either user or group must be provided"))

   if not rows:
       return "", 0

   details_cache = {}
   lines = []

   for row in rows:
       text = (row.message or "").strip()
       if not text:
           continue

       sender = row.from_user
       if sender not in details_cache:
           details_cache[sender] = get_chat_user_details(sender)
       details = details_cache[sender]
       name = details["full_name"] if details else sender

       timestamp = frappe.utils.get_datetime(row.creation).strftime("%b %d, %H:%M")
       lines.append(f"[{timestamp}] {name}: {text}")

   return "\n".join(lines), len(lines)


# ----------------------------------------------------------------------
# ASK THIS CHAT
# ----------------------------------------------------------------------

ASK_THIS_CHAT_INSTRUCTIONS = (
   "You will be given a transcript of a chat conversation, formatted as lines of "
   "'[timestamp] Sender: message'. Answer the user's question using ONLY information "
   "found in this transcript. If the answer isn't in the transcript, say clearly that "
   "you couldn't find it in the conversation instead of guessing or inventing details. "
   "Keep your answer brief (2-4 sentences unless the question genuinely needs more)."
)


@frappe.whitelist()
def ask_this_chat(question: str, user: str = None, group: str = None):
   """Answer a question about the current conversation, grounded only in its
   own message history. Exactly one of `user` (direct chat) or `group` should
   be provided by the client."""
   require_feature_enabled("ask_this_chat")

   question = (question or "").strip()
   if not question:
       frappe.throw(_("Please enter a question."))

   if not user and not group:
       frappe.throw(_("No conversation was specified."))

   transcript, message_count = get_thread_transcript(user=user, group=group,
limit=200)

   if not message_count:
       return {
           "answer": "There's no message history in this conversation yet, so I don't have anything to go on.",
           "message_count": 0,
       }

   system_prompt = _build_system_prompt(ASK_THIS_CHAT_INSTRUCTIONS)
   user_content = f"Conversation transcript:\n{transcript}\n\nQuestion: {question}"

   answer = get_ai_completion(
       messages=[{"role": "user", "content": user_content}],
       system_prompt=system_prompt,
   )

   return {"answer": answer, "message_count": message_count}


# ----------------------------------------------------------------------
# CONVERSATION SUMMARY
# ----------------------------------------------------------------------

CONVERSATION_SUMMARY_INSTRUCTIONS = (
   "You will be given a transcript of a chat conversation, formatted as lines of "
   "'[timestamp] Sender: message'. Produce a structured summary of it.\n\n"
   "Respond with ONLY valid JSON (no markdown, no code fences) matching exactly this shape:\n"
   '{"topic": "short topic string", "decisions": ["decision 1", ...], '
   '"action_items": [{"assignee": "name", "task": "what they will do"}], '
   '"pending": ["open question or unresolved item", ...]}\n\n'
   "Use an empty array for any section with nothing to report. Keep each entry to one "
   "short sentence. Do not invent information not present in the transcript."
)


@frappe.whitelist()
def conversation_summary(user: str = None, group: str = None):
   """Produce a structured summary (topic, decisions, action items, pending) of
   a conversation's full history. Exactly one of `user`/`group` should be given."""
   require_feature_enabled("conversation_summary")

   if not user and not group:
       frappe.throw(_("No conversation was specified."))

   transcript, message_count = get_thread_transcript(user=user, group=group,
limit=300)

   if not message_count:
       return {"topic": "", "decisions": [], "action_items": [], "pending": [],
"message_count": 0}

   system_prompt = _build_system_prompt(CONVERSATION_SUMMARY_INSTRUCTIONS)

   raw = get_ai_completion(
       messages=[{"role": "user", "content": f"Conversation transcript:\n{transcript}"}],
       system_prompt=system_prompt,
   )

   parsed = _parse_json_response(raw) or {}

   return {
       "topic": parsed.get("topic") or "",
       "decisions": parsed.get("decisions") or [],
       "action_items": parsed.get("action_items") or [],
       "pending": parsed.get("pending") or [],
       "message_count": message_count,
   }


# ----------------------------------------------------------------------
# CATCH ME UP
# Unlike the two features above, this is NOT scoped to one open conversation —
# it aggregates unread messages across every direct chat and group the user
# is part of, since that's the whole point ("what did I miss while I was away").
# ----------------------------------------------------------------------

CATCH_ME_UP_INSTRUCTIONS = (
   "You will be given a list of chat messages the user has not read yet, pulled from "
   "multiple direct chats and groups, oldest first. Each line is formatted as "
   "'[timestamp] Sender (in Group, if applicable): message'.\n\n"
   "Produce a short catch-up briefing. Respond with ONLY valid JSON (no markdown, no "
   "code fences) matching exactly this shape:\n"
   '{"urgent_count": <int>, "pending_count": <int>, "fyi_count": <int>, '
   '"highlights": ["short highlight sentence", ...]}\n\n'
   "- urgent_count: distinct topics needing action soon or flagging a problem\n"
   "- pending_count: distinct topics awaiting a reply or decision, not urgent\n"
   "- fyi_count: distinct informational topics needing no action\n"
   "These three counts should reflect distinct topics/threads you identify in the "
   "messages, not a raw per-message count.\n"
   "- highlights: 3-5 short sentences, most important first, each naming what happened "
   "and who's involved. No more than 5, no fewer than 1 if there is anything to report."
)


@frappe.whitelist()
def catch_me_up():
   """Aggregate everything the current user has missed across all of their
   direct chats and groups, and produce a prioritized, categorized briefing."""
   require_feature_enabled("catch_me_up")

   current_user = frappe.session.user

   direct_rows = frappe.db.sql(
       """
       SELECT from_user, message, creation
       FROM `tabChat Log`
       WHERE to_user = %(user)s AND seen = 0
       ORDER BY creation ASC
       LIMIT 300
       """,
       {"user": current_user},
       as_dict=True,
   )

   group_memberships = frappe.get_all(
       "Chat Group User",
       filters={"user": current_user, "parenttype": "Chat Group"},
       fields=["parent", "last_seen"],
   )

   group_rows = []
   for membership in group_memberships:
       conditions = "WHERE `group` = %(group)s AND from_user != %(user)s"
       values = {"group": membership.parent, "user": current_user, "limit": 300}
       if membership.last_seen:
           conditions += " AND creation > %(last_seen)s"
           values["last_seen"] = membership.last_seen

       rows = frappe.db.sql(
           f"""
           SELECT from_user, message, `group`, creation
           FROM `tabChat Log`
           {conditions}
           ORDER BY creation ASC
           LIMIT %(limit)s
           """,
           values,
           as_dict=True,
       )
       group_rows.extend(rows)

   all_rows = [r for r in (direct_rows + group_rows) if (r.message or "").strip()]
   all_rows.sort(key=lambda r: r.creation)

   missed_count = len(all_rows)

   if not missed_count:
       return {
           "missed_count": 0,
           "urgent_count": 0,
           "pending_count": 0,
           "fyi_count": 0,
           "highlights": [],
           "summary_text": "You're all caught up — no new messages since you last checked.",
       }

   details_cache = {}
   group_name_cache = {}
   lines = []

   for row in all_rows[:400]:
       sender = row.from_user
       if sender not in details_cache:
           details_cache[sender] = get_chat_user_details(sender)
       details = details_cache[sender]
       name = details["full_name"] if details else sender

       source = ""
       group_name = row.get("group")
       if group_name:
           if group_name not in group_name_cache:
               group_name_cache[group_name] = frappe.db.get_value("Chat Group",
group_name, "group_name")
           source = f" (in {group_name_cache[group_name]})"

       timestamp = frappe.utils.get_datetime(row.creation).strftime("%b %d, %H:%M")
       lines.append(f"[{timestamp}] {name}{source}: {row.message.strip()}")

   transcript = "\n".join(lines)
   system_prompt = _build_system_prompt(CATCH_ME_UP_INSTRUCTIONS)

   raw = get_ai_completion(
       messages=[{"role": "user", "content": f"Missed messages:\n{transcript}"}],
       system_prompt=system_prompt,
   )

   parsed = _parse_json_response(raw)

   if not parsed:
       return {
           "missed_count": missed_count,
           "urgent_count": 0,
           "pending_count": 0,
           "fyi_count": 0,
           "highlights": [],
           "summary_text": raw,
       }

   return {
       "missed_count": missed_count,
       "urgent_count": frappe.utils.cint(parsed.get("urgent_count")),
       "pending_count": frappe.utils.cint(parsed.get("pending_count")),
       "fyi_count": frappe.utils.cint(parsed.get("fyi_count")),
       "highlights": parsed.get("highlights") or [],
   }


# ----------------------------------------------------------------------
# AI REPLY ASSISTANT
# ----------------------------------------------------------------------

REPLY_ASSIST_ACTIONS = {"draft", "professional", "shorter", "friendlier",
"translate"}


@frappe.whitelist()
def reply_assist(action: str, text: str = None, user: str = None, group: str =
None, target_language: str = None):
   """Composer-side writing help. `draft` generates a suggested next reply from
   conversation context (no input text needed); the other actions rewrite the
   given `text` in place. Exactly one of `user`/`group` should be given for
   `draft` (it needs the conversation to draft against)."""
   require_feature_enabled("reply_assistant")

   action = (action or "").strip().lower()
   if action not in REPLY_ASSIST_ACTIONS:
       frappe.throw(_("Unknown reply assist action: {0}").format(action))

   if action == "draft":
       if not user and not group:
           frappe.throw(_("No conversation was specified."))

       transcript, message_count = get_thread_transcript(user=user, group=group,
limit=30)
       if not message_count:
           frappe.throw(_("There's no conversation yet to draft a reply for."))

       instructions = (
           "You will be given the most recent messages in a chat conversation, formatted as "
           "'[timestamp] Sender: message'. Write a natural, appropriately brief reply the "
           "current user could send next, continuing the conversation naturally. Return ONLY "
           "the reply text itself — no quotes, no explanation, no 'Here's a draft:' preamble."
       )
       system_prompt = _build_system_prompt(instructions)

       result = get_ai_completion(
           messages=[{"role": "user", "content": f"Recent messages:\n{transcript}\n\nWrite the next reply."}],
           system_prompt=system_prompt,
           max_tokens=300,
       )
       return {"result": result.strip()}

   text = (text or "").strip()
   if not text:
       frappe.throw(_("Write something first."))

   if action == "professional":
       instructions = (
           "Rewrite the given message to sound more professional and polished, while keeping "
           "its original meaning and roughly the same length. Return ONLY the rewritten "
           "message — no quotes, no explanation."
       )
   elif action == "shorter":
       instructions = (
           "Rewrite the given message to be noticeably shorter and more concise, while keeping "
           "its core meaning intact. Return ONLY the rewritten message — no quotes, no explanation."
       )
   elif action == "friendlier":
       instructions = (
           "Rewrite the given message to sound warmer and friendlier, while keeping its original "
           "meaning intact. Return ONLY the rewritten message — no quotes, no explanation."
       )
   elif action == "translate":
       target_language = (target_language or "").strip()
       if not target_language:
           frappe.throw(_("Please specify a target language."))
       instructions = (
           f"Translate the given message into {target_language}. Return ONLY the translated "
           "message — no quotes, no explanation, no original text alongside it."
       )

   system_prompt = _build_system_prompt(instructions)

   result = get_ai_completion(
       messages=[{"role": "user", "content": text}],
       system_prompt=system_prompt,
       max_tokens=400,
   )

   return {"result": result.strip()}


# ----------------------------------------------------------------------
# ACTION ITEMS
# ----------------------------------------------------------------------

ACTION_ITEMS_INSTRUCTIONS = (
   "You will be given today's date and a transcript of a chat conversation, formatted as "
   "lines of '[timestamp] Sender: message'. Identify concrete action items — things people "
   "explicitly committed to do (e.g. 'I'll contact the customer tomorrow', 'Rahul will "
   "verify the invoice').\n\n"
   "Respond with ONLY valid JSON (no markdown, no code fences) matching exactly this shape:\n"
   '{"items": [{"assignee": "name or null", "task": "short third-person description", '
   '"due": "YYYY-MM-DD or null"}]}\n\n'
   "- assignee: the person's name as it appears in the transcript, or null if unclear who\n"
   "- task: a short, clear description written in third person (e.g. 'Contact the customer'), "
   "not a direct quote\n"
   "- due: resolve relative dates ('tomorrow', 'Friday') to an actual YYYY-MM-DD date using "
   "the message's own timestamp as reference, or null if no due date was mentioned\n"
   "Only include genuine commitments to do something in the future — not questions, opinions, "
   "or things already completed. Return an empty items array if there are none. Do not invent "
   "items not actually present in the transcript."
)


def _resolve_assignee(name: str):
   """Best-effort match of a free-text name (as the AI extracted it from chat)
   to an actual Chat User account, for task assignment. Returns None rather
   than guessing wrong if there's no reasonably confident match."""
   if not name:
       return None

   name = name.strip()
   if not name:
       return None

   exact = frappe.db.get_value("Chat User", {"user_name": name}, "user")
   if exact:
       return exact

   matches = frappe.get_all(
       "Chat User",
       filters={"user_name": ["like", f"%{name}%"]},
       pluck="user",
       limit=2,
   )
   # Only trust a partial match if it's unambiguous — one hit, not several.
   return matches[0] if len(matches) == 1 else None


def _try_parse_due_date(due: str):
   if not due:
       return None
   try:
       return frappe.utils.getdate(due)
   except Exception:
       return None


@frappe.whitelist()
def detect_action_items(user: str = None, group: str = None):
   """Scan a conversation's history for concrete commitments and return them
   as structured, editable items the user can turn into real Tasks."""
   require_feature_enabled("action_items")

   if not user and not group:
       frappe.throw(_("No conversation was specified."))

   transcript, message_count = get_thread_transcript(user=user, group=group,
limit=200)

   if not message_count:
       return {"items": [], "message_count": 0}

   system_prompt = _build_system_prompt(ACTION_ITEMS_INSTRUCTIONS)
   today_str = frappe.utils.today()

   raw = get_ai_completion(
       messages=[{"role": "user", "content": f"Today's date: {today_str}\n\nConversation transcript:\n{transcript}"}],
       system_prompt=system_prompt,
   )

   parsed = _parse_json_response(raw) or {}
   raw_items = parsed.get("items") or []

   items = []
   for item in raw_items:
       if not isinstance(item, dict):
           continue
       task = (item.get("task") or "").strip()
       if not task:
           continue
       items.append(
           {
               "assignee": (item.get("assignee") or "").strip() or None,
               "task": task,
               "due": (item.get("due") or "").strip() or None,
           }
       )

   return {"items": items, "message_count": message_count}


@frappe.whitelist()
def create_tasks_from_action_items(items):
   """Create real Frappe Task records from a list of (user-reviewed, user-selected)
   action items. Assignment is best-effort: if the assignee name can't be confidently matched to a Chat User, the task is still created, just unassigned."""
   require_feature_enabled("action_items")

   if not frappe.db.exists("DocType", "Task"):
       frappe.throw(_("The Task doctype isn't available on this site."))

   if isinstance(items, str):
       items = frappe.parse_json(items)
   items = items or []

   if not items:
       frappe.throw(_("No action items were provided."))

   created = []

   for item in items:
       if not isinstance(item, dict):
           continue

       task_text = (item.get("task") or "").strip()
       if not task_text:
           continue

       task_doc = frappe.get_doc(
           {
               "doctype": "Task",
               "subject": task_text[:140],
               "description": task_text,
               "status": "Open",
           }
       )

       due_date = _try_parse_due_date(item.get("due"))
       if due_date:
           task_doc.exp_end_date = due_date

       task_doc.insert(ignore_permissions=True)

       assigned_user = _resolve_assignee(item.get("assignee"))
       if assigned_user:
           try:
               from frappe.desk.form.assign_to import add as assign_to_add

               assign_to_add(
                   {
                       "assign_to": [assigned_user],
                       "doctype": "Task",
                       "name": task_doc.name,
                   }
               )
           except Exception:
               frappe.log_error(title="AI Action Items: assignment failed",
message=frappe.get_traceback())
               assigned_user = None

       created.append(
           {
               "task": task_doc.name,
               "subject": task_doc.subject,
               "assigned_user": assigned_user,
           }
       )

   frappe.db.commit()

   return {"created": created}


# ----------------------------------------------------------------------
# ASK AI ACROSS MY CHATS
# Lightweight cross-conversation search — NOT company-wide, no ERPNext data.
# Retrieval is plain SQL keyword matching (no vector index), which is enough
# for "did anyone mention X" style questions without new infrastructure.
# The full "Ask Your Company" feature (chats + ERPNext + attachments) is a
# separate, heavier Phase 2 build on top of a proper retrieval layer.
# ----------------------------------------------------------------------

_STOPWORDS = {
   "the", "a", "an", "is", "are", "was", "were", "what", "when", "where", "who",
   "how", "did", "do", "does", "about", "with", "for", "and", "or", "to", "of",
   "in", "on", "at", "that", "this", "it", "we", "i", "you", "they", "he", "she",
   "say", "said", "tell", "me", "us", "our", "my", "your", "any", "anyone",
   "there", "have", "has", "had", "been", "being", "will", "would", "could",
}


def _extract_search_terms(question: str, max_terms: int = 6):
   """Pull a handful of meaningful keywords out of a question via simple
   stopword filtering — cheap and fast, avoids spending an extra AI call
   just to extract search terms for what is meant to be a lightweight feature."""
   words = re.findall(r"[a-zA-Z0-9']+", (question or "").lower())
   terms = [w for w in words if w not in _STOPWORDS and len(w) > 2]

   seen = set()
   result = []
   for w in terms:
       if w not in seen:
           seen.add(w)
           result.append(w)

   return result[:max_terms]


def _search_user_messages(current_user: str, terms: list, total_cap: int = 80):
   """Keyword search (SQL LIKE, OR'd across terms) over every message the
   current user can see — their direct chats and the groups they belong to.
   Returns raw rows, newest first, deduplicated, capped."""
   if not terms:
       return []

   like_clauses = " OR ".join([f"message LIKE %(term{i})s" for i in
range(len(terms))])
   values = {f"term{i}": f"%{t}%" for i, t in enumerate(terms)}

   direct_rows = frappe.db.sql(
       f"""
       SELECT name, from_user, to_user, `group`, message, creation
       FROM `tabChat Log`
       WHERE (from_user = %(user)s OR to_user = %(user)s)
         AND `group` IS NULL
         AND ({like_clauses})
       ORDER BY creation DESC
       LIMIT {total_cap}
       """,
       {**values, "user": current_user},
       as_dict=True,
   )

   group_names = frappe.get_all(
       "Chat Group User",
       filters={"user": current_user, "parenttype": "Chat Group"},
       pluck="parent",
   )

   group_rows = []
   if group_names:
       group_values = dict(values)
       placeholders = []
       for i, g in enumerate(group_names):
           key = f"g{i}"
           group_values[key] = g
           placeholders.append(f"%({key})s")

       group_rows = frappe.db.sql(
           f"""
           SELECT name, from_user, to_user, `group`, message, creation
           FROM `tabChat Log`
           WHERE `group` IN ({", ".join(placeholders)})
             AND ({like_clauses})
           ORDER BY creation DESC
           LIMIT {total_cap}
           """,
           group_values,
           as_dict=True,
       )

   seen = set()
   result = []
   for row in sorted(direct_rows + group_rows, key=lambda r: r.creation,
reverse=True):
       if row.name in seen:
           continue
       seen.add(row.name)
       result.append(row)
       if len(result) >= total_cap:
           break

   return result


CHAT_SEARCH_INSTRUCTIONS = (
   "You will be given a set of chat messages retrieved from across the user's own "
   "conversations (direct chats and groups), because they matched keywords from the "
   "user's question. Each line is formatted as '[timestamp] Sender (in Source): message'. "
   "These are NOT one continuous conversation — they may come from different chats.\n\n"
   "Answer the user's question using ONLY information found in these messages. Mention "
   "which conversation or person a key fact came from when it's relevant. If the answer "
   "isn't in these messages, say clearly that you couldn't find it — do not guess or "
   "invent details. Keep your answer brief (2-5 sentences unless genuinely more is needed)."
)


@frappe.whitelist()
def ask_across_chats(question: str):
   """Answer a question by keyword-searching across ALL of the current user's
   own direct chats and groups. Lightweight version — no ERPNext data."""
   require_feature_enabled("chat_search")

   current_user = frappe.session.user
   question = (question or "").strip()
   if not question:
       frappe.throw(_("Please enter a question."))

   terms = _extract_search_terms(question)
   if not terms:
       return {
           "answer": "Could you add a bit more detail? I couldn't pick out enough to search on.",
           "sources": [],
       }

   rows = _search_user_messages(current_user, terms)
   if not rows:
       return {"answer": "I couldn't find anything in your chats matching that.",
"sources": []}

   details_cache = {}
   group_name_cache = {}
   lines = []
   sources = []

   for row in sorted(rows, key=lambda r: r.creation):
       sender = row.from_user
       if sender not in details_cache:
           details_cache[sender] = get_chat_user_details(sender)
       details = details_cache[sender]
       name = details["full_name"] if details else sender

       group_name = row.get("group")
       if group_name:
           if group_name not in group_name_cache:
               group_name_cache[group_name] = frappe.db.get_value("Chat Group",
group_name, "group_name")
           source_label = group_name_cache[group_name] or group_name
           source_type = "group"
       else:
           other = row.to_user if row.from_user == current_user else row.from_user
           if other not in details_cache:
               details_cache[other] = get_chat_user_details(other)
           other_details = details_cache[other]
           source_label = other_details["full_name"] if other_details else other
           source_type = "direct"

       timestamp = frappe.utils.get_datetime(row.creation).strftime("%b %d, %H:%M")
       lines.append(f"[{timestamp}] {name} (in {source_label}): {(row.message or '').strip()}")
       sources.append({"type": source_type, "label": source_label})

   transcript = "\n".join(lines)
   system_prompt = _build_system_prompt(CHAT_SEARCH_INSTRUCTIONS)

   answer = get_ai_completion(
       messages=[{"role": "user", "content": f"Question: {question}\n\nRetrieved messages:\n{transcript}"}],
       system_prompt=system_prompt,
   )

   seen_labels = set()
   unique_sources = []
   for src in reversed(sources):  # most recent first
       if src["label"] in seen_labels:
           continue
       seen_labels.add(src["label"])
       unique_sources.append(src)
       if len(unique_sources) >= 5:
           break

   return {"answer": answer, "sources": unique_sources}



# ----------------------------------------------------------------------
# ASK AI ABOUT ERPNext / FRAPPE
# Phase 2 is deliberately DocType-driven rather than hard-coded to a small
# list such as Company/Customer/Sales Invoice/Sales Order. A Frappe site can
# have hundreds of standard and custom DocTypes, so the model first chooses
# relevant DocTypes from the site's catalog and the server then retrieves only
# records the current user is allowed to read.
# ----------------------------------------------------------------------

ERP_AI_MAX_DOCTYPES = 8
ERP_AI_MAX_RECORDS_PER_DOCTYPE = 20
ERP_AI_MAX_TOTAL_RECORDS = 100
ERP_AI_MAX_CATALOG_DOCTYPES = 2000
ERP_AI_SEARCHABLE_FIELD_TYPES = {
    "Data",
    "Small Text",
    "Text",
    "Long Text",
    "Text Editor",
    "Select",
    "Link",
    "Dynamic Link",
    "Phone",
    "Email",
    "Barcode",
    "Read Only",
}


def _get_erpnext_doctype_catalog():
    """Return the site's non-child, non-single DocTypes the current user can read.

    The list is generated from DocType metadata, so standard ERPNext DocTypes,
    custom application DocTypes, and customer-created DocTypes are all eligible.
    """
    rows = frappe.get_all(
        "DocType",
        filters={"istable": 0, "issingle": 0},
        fields=["name", "module"],
        order_by="name asc",
        limit_page_length=ERP_AI_MAX_CATALOG_DOCTYPES,
    )

    result = []
    for row in rows:
        doctype = row.name
        if not doctype or doctype in {"DocType", "DocField", "DocPerm"}:
            continue
        try:
            if not frappe.has_permission(doctype, ptype="read"):
                continue
        except Exception:
            continue
        result.append({"name": doctype, "module": row.module or ""})
    return result


def _get_searchable_fields(doctype, max_fields=16):
    """Return useful scalar fields for text retrieval, never table fields."""
    try:
        meta = frappe.get_meta(doctype)
    except Exception:
        return []

    fields = []
    for field in meta.fields:
        if field.fieldtype not in ERP_AI_SEARCHABLE_FIELD_TYPES:
            continue
        if not field.fieldname or field.fieldname in {"name", "owner", "modified_by"}:
            continue
        fields.append(
            {
                "fieldname": field.fieldname,
                "label": field.label or field.fieldname,
                "fieldtype": field.fieldtype,
            }
        )
        if len(fields) >= max_fields:
            break
    return fields


def _rank_erpnext_doctypes(question, catalog):
    """Cheap lexical ranking used as a safe fallback and to keep planner context small."""
    terms = _extract_search_terms(question, max_terms=12)
    scored = []
    for row in catalog:
        name = row["name"]
        haystack = name.lower().replace("_", " ")
        score = 0
        for term in terms:
            if term in haystack:
                score += 5
        try:
            fields = _get_searchable_fields(name, max_fields=12)
        except Exception:
            fields = []
        for field in fields:
            field_text = f"{field['fieldname']} {field['label']}".lower().replace("_", " ")
            for term in terms:
                if term in field_text:
                    score += 1
        scored.append((score, name, row.get("module") or "", fields))

    scored.sort(key=lambda item: (-item[0], item[1].lower()))
    return scored


def _build_erpnext_planner_context(question, catalog):
    """Build a compact catalog context for the model without exposing records yet."""
    ranked = _rank_erpnext_doctypes(question, catalog)
    top_names = [row["name"] for row in catalog]
    field_rows = []
    for score, name, module, fields in ranked[:120]:
        if not fields:
            continue
        field_rows.append(
            f"{name} [{module}]: "
            + ", ".join(f"{f['fieldname']} ({f['label']})" for f in fields)
        )

    return (
        "Available DocTypes (exact names):\n"
        + "\n".join(top_names)
        + "\n\nRelevant field hints for likely matches:\n"
        + "\n".join(field_rows)
    )


ERP_AI_PLANNER_INSTRUCTIONS = (
    "You are the retrieval planner for an AI assistant inside a Frappe/ERPNext site. "
    "You are given a user's natural-language question and a catalog of available DocTypes. "
    "Choose only DocTypes that are relevant to answering the question. Never invent a DocType "
    "name; use an exact name from the supplied catalog. You are planning retrieval, not answering "
    "the question.\n\n"
    "Return ONLY valid JSON in exactly this shape:\n"
    '{"doctypes":["Customer"],"search_terms":["ABC"],"count_only":false,"limit":20}\n\n'
    "Rules:\n"
    "- Select 1-8 relevant DocTypes.\n"
    "- search_terms should contain concrete names, identifiers, numbers, or phrases worth looking for.\n"
    "- Do not put generic question words into search_terms.\n"
    "- Set count_only true only when the user explicitly asks for a count/number and records themselves "
    "are not needed to answer it.\n"
    "- limit must be between 1 and 20.\n"
    "- If the question is broad, choose the most relevant DocTypes rather than every DocType."
)


def _plan_erpnext_retrieval(question, catalog):
    """Ask the configured model which accessible DocTypes should be retrieved."""
    context = _build_erpnext_planner_context(question, catalog)
    raw = get_ai_completion(
        messages=[
            {
                "role": "user",
                "content": f"User question:\n{question}\n\n{context}",
            }
        ],
        system_prompt=_build_system_prompt(ERP_AI_PLANNER_INSTRUCTIONS),
        max_tokens=500,
        temperature=0,
    )
    parsed = _parse_json_response(raw) or {}
    allowed = {row["name"] for row in catalog}
    selected = []
    for doctype in parsed.get("doctypes") or []:
        if not isinstance(doctype, str):
            continue
        doctype = doctype.strip()
        if doctype in allowed and doctype not in selected:
            selected.append(doctype)
        if len(selected) >= ERP_AI_MAX_DOCTYPES:
            break

    terms = []
    for term in parsed.get("search_terms") or []:
        if isinstance(term, str):
            term = term.strip()
            if term and term not in terms:
                terms.append(term[:100])
        if len(terms) >= 8:
            break

    limit = frappe.utils.cint(parsed.get("limit")) or 20
    limit = max(1, min(limit, ERP_AI_MAX_RECORDS_PER_DOCTYPE))
    return {
        "doctypes": selected,
        "search_terms": terms,
        "count_only": bool(parsed.get("count_only")),
        "limit": limit,
    }


def _retrieve_erpnext_records(doctype, search_terms=None, limit=20, count_only=False):
    """Retrieve only records visible to the current user using frappe.get_list()."""
    if not frappe.has_permission(doctype, ptype="read"):
        return {"doctype": doctype, "count": 0, "records": [], "skipped": "no_read_permission"}

    meta = frappe.get_meta(doctype)
    fields = ["name"]
    searchable_fields = _get_searchable_fields(doctype, max_fields=18)
    fields.extend(f["fieldname"] for f in searchable_fields)
    fields = list(dict.fromkeys(fields))

    if count_only and not search_terms:
        count = frappe.db.count(doctype)
        return {"doctype": doctype, "count": count, "records": []}

    or_filters = []
    for term in search_terms or []:
        for field in searchable_fields:
            or_filters.append([field["fieldname"], "like", f"%{term}%"])
        # The document name is a valid searchable identifier even though it is
        # not part of DocType meta.fields.
        or_filters.append(["name", "like", f"%{term}%"])

    kwargs = {
        "doctype": doctype,
        "fields": fields,
        "limit_page_length": limit,
        "order_by": "modified desc",
    }
    if or_filters:
        kwargs["or_filters"] = or_filters

    try:
        records = frappe.get_list(**kwargs)
    except Exception as exc:
        frappe.log_error(
            title="AI ERPNext Retrieval Failed",
            message=f"{doctype}: {frappe.get_traceback()}",
        )
        return {"doctype": doctype, "count": 0, "records": [], "error": str(exc)}

    safe_records = []
    for row in records:
        safe = {"name": row.get("name")}
        for field in searchable_fields:
            value = row.get(field["fieldname"])
            if value in (None, ""):
                continue
            # Avoid pushing huge text blobs into the model.
            if isinstance(value, str) and len(value) > 1000:
                value = value[:1000] + "…"
            safe[field["fieldname"]] = value
        safe_records.append(safe)

    return {"doctype": doctype, "count": len(safe_records), "records": safe_records}


def _format_erpnext_context(retrieved):
    """Serialize retrieved records into compact, explicit model context."""
    chunks = []
    total = 0
    for result in retrieved:
        doctype = result.get("doctype")
        if result.get("error"):
            chunks.append(f"DocType: {doctype}\nRetrieval error: unavailable")
            continue
        records = result.get("records") or []
        if not records and result.get("count") is not None:
            chunks.append(f"DocType: {doctype}\nAccessible matching record count: {result.get('count', 0)}")
            continue
        lines = [f"DocType: {doctype}", f"Matching records: {len(records)}"]
        for record in records:
            lines.append(json.dumps(record, ensure_ascii=False, default=str))
            total += 1
            if total >= ERP_AI_MAX_TOTAL_RECORDS:
                break
        chunks.append("\n".join(lines))
        if total >= ERP_AI_MAX_TOTAL_RECORDS:
            break
    return "\n\n".join(chunks)


ERP_AI_ANSWER_INSTRUCTIONS = (
    "You are the ERPNext intelligence assistant. Answer the user's question using ONLY the "
    "permission-filtered ERPNext context supplied below. The context may contain records from "
    "multiple DocTypes. Do not claim to have access to records that are not present. Do not invent "
    "values. If the retrieved context is insufficient, say what could not be found. Be concise but "
    "useful. When relevant, mention the DocType and document name supporting an important fact. "
    "If a count is shown as an accessible matching record count, distinguish that from a count of "
    "records actually returned."
)


@frappe.whitelist()
def ask_erpnext(question: str):
    """Answer a natural-language question using permission-aware ERPNext retrieval across DocTypes."""
    require_feature_enabled("erpnext_search")
    question = (question or "").strip()
    if not question:
        frappe.throw(_("Please enter a question."))

    catalog = _get_erpnext_doctype_catalog()
    if not catalog:
        return {
            "answer": "I couldn't find any ERPNext DocTypes that you are allowed to read.",
            "sources": [],
            "doctypes": [],
        }

    try:
        plan = _plan_erpnext_retrieval(question, catalog)
    except Exception:
        ranked = _rank_erpnext_doctypes(question, catalog)
        plan = {
            "doctypes": [row[1] for row in ranked[:ERP_AI_MAX_DOCTYPES]],
            "search_terms": _extract_search_terms(question, max_terms=6),
            "count_only": False,
            "limit": 20,
        }

    if not plan["doctypes"]:
        ranked = _rank_erpnext_doctypes(question, catalog)
        plan["doctypes"] = [row[1] for row in ranked[:ERP_AI_MAX_DOCTYPES]]

    retrieved = []
    for doctype in plan["doctypes"]:
        if len(retrieved) >= ERP_AI_MAX_DOCTYPES:
            break
        result = _retrieve_erpnext_records(
            doctype,
            search_terms=plan["search_terms"],
            limit=plan["limit"],
            count_only=plan["count_only"],
        )
        retrieved.append(result)

    context = _format_erpnext_context(retrieved)
    if not context:
        context = "No matching records were returned from the selected accessible DocTypes."

    answer = get_ai_completion(
        messages=[
            {
                "role": "user",
                "content": (
                    f"User question:\n{question}\n\n"
                    f"Permission-filtered ERPNext context:\n{context}"
                ),
            }
        ],
        system_prompt=_build_system_prompt(ERP_AI_ANSWER_INSTRUCTIONS),
        max_tokens=1200,
    )

    sources = []
    for result in retrieved:
        for record in result.get("records") or []:
            name = record.get("name")
            if name:
                sources.append({"type": "doctype", "doctype": result["doctype"], "label": f"{result['doctype']}: {name}"})
            if len(sources) >= 20:
                break
        if len(sources) >= 20:
            break

    return {
        "answer": answer,
        "sources": sources,
        "doctypes": [r["doctype"] for r in retrieved],
    }
