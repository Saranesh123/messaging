import frappe
from frappe import _
from frappe.utils import now_datetime, cint

USER_DOCTYPE = "Chat User"
USER_ID_FIELD = "user_name"
USER_NAME_FIELD = "user_name"
USER_IMAGE_FIELD = "user_image"
NOTIFICATION_BOT_USER = "notifications-bot@example.com"
ONLINE_TTL = 90

@frappe.whitelist()
def heartbeat():
	"""Call this every ~30s from the client (and on window focus) to mark the
	current user online."""
	frappe.cache().set_value(
		f"chat_online:{frappe.session.user}", "1", expires_in_sec=ONLINE_TTL
	)

@frappe.whitelist()
def get_online_status(users):
	"""users: JSON list of user ids. Returns {user: bool}"""
	if isinstance(users, str):
		users = frappe.parse_json(users)
	result = {}
	for u in users:
		result[u] = bool(frappe.cache().get_value(f"chat_online:{u}"))
	return result

@frappe.whitelist()
def search_users(txt=""):
	filters = {USER_ID_FIELD: ["!=", frappe.session.user]}
	if USER_DOCTYPE == "Chat User":
		filters["enabled"] = 1
 
	or_filters = None
	if txt:
		or_filters = [
			[USER_DOCTYPE, USER_NAME_FIELD, "like", f"%{txt}%"],
			[USER_DOCTYPE, USER_ID_FIELD, "like", f"%{txt}%"],
		]
 
	users = frappe.get_list(
		USER_DOCTYPE,
		filters=filters,
		or_filters=or_filters,
		fields=[f"{USER_ID_FIELD} as user", f"{USER_NAME_FIELD} as full_name", f"{USER_IMAGE_FIELD} as image"],
		limit_page_length=20,
		order_by=f"{USER_NAME_FIELD} asc",
	)
	return users
 
 
# ---------------------------------------------------------------------------
# Conversation list (left panel)
# ---------------------------------------------------------------------------
@frappe.whitelist()
def get_conversations():
	me = frappe.session.user
 
	rows = frappe.db.sql(
		"""
		select
			case when from_user = %(me)s then to_user else from_user end as contact,
			message, message_type, creation, seen, from_user
		from `tabChat Log`
		where from_user = %(me)s or to_user = %(me)s
		order by creation desc
		""",
		{"me": me},
		as_dict=True,
	)
 
	conversations = {}
	unread_map = {}
	for r in rows:
		if r.contact not in conversations:
			conversations[r.contact] = {
				"user": r.contact,
				"last_message": r.message,
				"last_message_type": r.message_type,
				"last_time": r.creation,
			}
		if r.from_user != me and not r.seen:
			unread_map[r.contact] = unread_map.get(r.contact, 0) + 1
 
	contacts = list(conversations.keys())
	user_meta = {}
	if contacts:
		metas = frappe.get_all(
			USER_DOCTYPE,
			filters=[[USER_DOCTYPE, USER_ID_FIELD, "in", contacts]],
			fields=[f"{USER_ID_FIELD} as user", f"{USER_NAME_FIELD} as full_name", f"{USER_IMAGE_FIELD} as image"],
		)
		user_meta = {m.user: m for m in metas}
 
	result = []
	for user, convo in conversations.items():
		meta = user_meta.get(user, {})
		result.append({
			**convo,
			"full_name": meta.get("full_name", user),
			"image": meta.get("image"),
			"unread": unread_map.get(user, 0),
			"is_bot": user == NOTIFICATION_BOT_USER,
		})
 
	result.sort(key=lambda x: x["last_time"], reverse=True)
	return result
 
 
@frappe.whitelist()
def get_unread_count():
	me = frappe.session.user
	return frappe.db.count("Chat Log", {"to_user": me, "seen": 0})
 
 
# ---------------------------------------------------------------------------
# Conversation thread
# ---------------------------------------------------------------------------
@frappe.whitelist()
def get_messages(user, start=0, page_length=30):
	me = frappe.session.user
	start = cint(start)
	page_length = cint(page_length)
 
	messages = frappe.db.sql(
		"""
		select name, from_user, to_user, message, message_type, seen, creation
		from `tabChat Log`
		where (from_user = %(me)s and to_user = %(user)s)
		   or (from_user = %(user)s and to_user = %(me)s)
		order by creation desc
		limit %(start)s, %(page_length)s
		""",
		{"me": me, "user": user, "start": start, "page_length": page_length},
		as_dict=True,
	)
	messages.reverse()
 
	# mark the other party's messages as seen + notify them (read receipts)
	unseen = [m.name for m in messages if m.to_user == me and not m.seen]
	if unseen:
		frappe.db.set_value(
			"Chat Log", {"name": ["in", unseen]},
			{"seen": 1, "seen_on": now_datetime()},
		)
		frappe.publish_realtime("chat:seen", {"by": me}, user=user)
 
	return messages
 
 
# ---------------------------------------------------------------------------
# Send a message
# ---------------------------------------------------------------------------
@frappe.whitelist()
def send_message(to_user, message):
	if not message or not message.strip():
		frappe.throw(_("Message cannot be empty"))
 
	doc = frappe.get_doc({
		"doctype": "Chat Log",
		"from_user": frappe.session.user,
		"to_user": to_user,
		"message": message.strip(),
		"message_type": "Text",
	})
	doc.insert(ignore_permissions=True)
 
	payload = {
		"name": doc.name,
		"from_user": doc.from_user,
		"to_user": doc.to_user,
		"message": doc.message,
		"message_type": doc.message_type,
		"creation": doc.creation,
	}
	# push to recipient (all their open tabs/sessions)
	frappe.publish_realtime("chat:new_message", payload, user=to_user)
	# echo back to sender's other tabs for sync
	frappe.publish_realtime("chat:new_message", payload, user=doc.from_user)
 
	return payload
 
 
@frappe.whitelist()
def set_typing(to_user):
	frappe.publish_realtime(
		"chat:typing", {"from_user": frappe.session.user}, user=to_user
	)
 
 
# ---------------------------------------------------------------------------
# Notification Log -> Chat Log bridge (Notification Bot)
# Hook this into hooks.py doc_events, see hooks_snippet.py
# ---------------------------------------------------------------------------
def handle_notification_log(doc, method=None):
	if not frappe.db.exists("User", NOTIFICATION_BOT_USER):
		# Bot user not set up yet — skip silently instead of breaking the
		# original Notification Log insert.
		return
 
	target_user = doc.for_user
	if not target_user or target_user == NOTIFICATION_BOT_USER:
		return
 
	message = doc.subject or doc.get("message") or _("You have a new notification")
	# strip HTML for a clean chat bubble
	message = frappe.utils.strip_html(message)
 
	chat_doc = frappe.get_doc({
		"doctype": "Chat Log",
		"from_user": NOTIFICATION_BOT_USER,
		"to_user": target_user,
		"message": message,
		"message_type": "Notification",
	})
	chat_doc.insert(ignore_permissions=True)
 
	payload = {
		"name": chat_doc.name,
		"from_user": NOTIFICATION_BOT_USER,
		"to_user": target_user,
		"message": chat_doc.message,
		"message_type": "Notification",
		"creation": chat_doc.creation,
	}
	frappe.publish_realtime("chat:new_message", payload, user=target_user)