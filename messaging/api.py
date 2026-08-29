import frappe
from frappe import _
from frappe.utils import now_datetime, get_datetime, strip_html


# ----------------------------------------------------------------------
# HELPERS
# ----------------------------------------------------------------------

NOTIFICATION_BOT_USER = "notifications-bot@example.com"


def get_chat_user(user: str):
	"""Return Chat User document for a Frappe User."""
	if not user or not frappe.db.exists("Chat User", user):
		return None
	return frappe.get_doc("Chat User", user)


def ensure_chat_user(user: str):
	"""Ensure a valid System User has a Chat User record."""
	if not user or user == "Guest":
		return None

	if frappe.db.exists("Chat User", user):
		return frappe.get_doc("Chat User", user)

	frappe_user = frappe.db.get_value(
		"User",
		user,
		["name", "full_name", "user_image", "enabled", "user_type"],
		as_dict=True,
	)

	if not frappe_user or frappe_user.user_type != "System User" or not frappe_user.enabled:
		return None

	chat_user = frappe.get_doc(
		{
			"doctype": "Chat User",
			"user": frappe_user.name,
			"enabled": 1,
		}
	)
	chat_user.insert(ignore_permissions=True)
	return chat_user


def get_chat_user_details(user: str):
	"""Return display details for a Chat User or Bot."""
	if not user:
		return None

	if user == NOTIFICATION_BOT_USER:
		return {
			"user": NOTIFICATION_BOT_USER,
			"full_name": "Notification Bot",
			"image": None,
			"enabled": 1,
			"is_bot": True,
		}

	row = frappe.db.get_value(
		"Chat User",
		user,
		["user", "user_name", "user_image", "enabled"],
		as_dict=True,
	)

	if not row:
		# Fallback to User table if Chat User record is missing
		user_row = frappe.db.get_value("User", user, ["name", "full_name", "user_image", "enabled"], as_dict=True)
		if not user_row:
			return None
		return {
			"user": user_row.name,
			"full_name": user_row.full_name or user_row.name,
			"image": user_row.user_image,
			"enabled": user_row.enabled,
			"is_bot": False,
		}

	return {
		"user": row.user,
		"full_name": row.user_name or row.user,
		"image": row.user_image,
		"enabled": row.enabled,
		"is_bot": False,
	}


def get_other_user(log: dict):
	"""Get the counterparty user ID in a conversation log."""
	current_user = frappe.session.user
	return log.to_user if log.from_user == current_user else log.from_user


# ----------------------------------------------------------------------
# ATTACHMENT HELPERS
# ----------------------------------------------------------------------

def build_attachment_rows(attachments):
	"""Normalize incoming attachment metadata (from the client, after upload_file)
	into Chat Attachment child-table row dicts. Silently drops malformed entries."""
	if isinstance(attachments, str):
		attachments = frappe.parse_json(attachments)
	attachments = attachments or []

	rows = []
	for a in attachments:
		if not isinstance(a, dict):
			continue
		file_url = (a.get("file_url") or "").strip()
		if not file_url:
			continue
		rows.append(
			{
				"file_url": file_url,
				"file_name": (a.get("file_name") or file_url.split("/")[-1])[:255],
				"file_type": (a.get("file_type") or "")[:100],
				"file_size": frappe.utils.cint(a.get("file_size") or 0),
			}
		)
	return rows


def relink_attachment_files(file_urls, docname):
	"""Point the already-uploaded File docs at the Chat Log they now belong to,
	so permissions/cleanup follow the message instead of floating unattached."""
	for file_url in file_urls:
		file_name = frappe.db.get_value("File", {"file_url": file_url}, "name")
		if file_name:
			frappe.db.set_value(
				"File",
				file_name,
				{"attached_to_doctype": "Chat Log", "attached_to_name": docname},
				update_modified=False,
			)


def attach_attachments_to_messages(messages):
	"""Bulk-fetch Chat Attachment rows for a list of message dicts and attach
	them as an `attachments` list on each, in one extra query."""
	if not messages:
		return messages

	names = [m.name for m in messages]
	rows = frappe.get_all(
		"Chat Attachment",
		filters={"parent": ["in", names], "parenttype": "Chat Log"},
		fields=["parent", "file_url", "file_name", "file_type", "file_size"],
		order_by="idx asc",
	)

	grouped = {}
	for row in rows:
		grouped.setdefault(row.parent, []).append(
			{
				"file_url": row.file_url,
				"file_name": row.file_name,
				"file_type": row.file_type,
				"file_size": row.file_size,
			}
		)

	for m in messages:
		m["attachments"] = grouped.get(m.name, [])

	return messages


# ----------------------------------------------------------------------
# GROUP HELPERS
# ----------------------------------------------------------------------

def get_group_member_names(group: str):
	"""Return list of Chat User names that belong to a group."""
	return frappe.get_all(
		"Chat Group User",
		filters={"parent": group, "parenttype": "Chat Group"},
		pluck="user",
	)


def is_group_member(group: str, user: str):
	"""Check whether a user is a member of a group."""
	return bool(
		frappe.db.exists(
			"Chat Group User",
			{"parent": group, "parenttype": "Chat Group", "user": user},
		)
	)


def is_group_admin(group: str, user: str):
	"""Check whether a user is an admin of a group."""
	return bool(
		frappe.db.get_value(
			"Chat Group User",
			{"parent": group, "parenttype": "Chat Group", "user": user},
			"is_admin",
		)
	)


def group_seen_cache_key(group: str, user: str):
	"""Kept only for reference — no longer used now that last_seen lives on Chat Group User."""
	return f"chat_group_seen:{group}:{user}"


def get_group_last_seen(group: str, user: str):
	"""Read the persisted last-seen timestamp for a member, stored on their Chat Group User row."""
	return frappe.db.get_value(
		"Chat Group User",
		{"parent": group, "parenttype": "Chat Group", "user": user},
		"last_seen",
	)


def mark_group_seen(group: str, user: str):
	"""Persist the timestamp up to which a user has viewed a group's messages."""
	frappe.db.set_value(
		"Chat Group User",
		{"parent": group, "parenttype": "Chat Group", "user": user},
		"last_seen",
		now_datetime(),
		update_modified=False,
	)


def count_group_unread(group: str, user: str):
	"""Count messages in a group sent after the user's last seen timestamp, excluding their own."""
	last_seen = get_group_last_seen(group, user)

	conditions = "WHERE `group` = %(group)s AND from_user != %(user)s"
	values = {"group": group, "user": user}

	if last_seen:
		conditions += " AND creation > %(last_seen)s"
		values["last_seen"] = last_seen

	count = frappe.db.sql(f"SELECT COUNT(*) FROM `tabChat Log` {conditions}", values)[0][0]
	return count or 0


def get_group_summary(group: str, current_user: str):
	"""Build a display-ready summary dict for a Chat Group."""
	doc = frappe.get_doc("Chat Group", group)
	members = [row.user for row in doc.users]

	last_log = frappe.db.get_value(
		"Chat Log",
		{"group": group},
		["message", "creation", "from_user"],
		order_by="creation desc",
		as_dict=True,
	)

	member_details = []
	for row in doc.users:
		details = get_chat_user_details(row.user)
		if details:
			details = dict(details)
			details["is_admin"] = bool(row.is_admin)
			member_details.append(details)

	return {
		"group": doc.name,
		"group_name": doc.group_name,
		"group_image": doc.group_image,
		"is_group": True,
		"members": member_details,
		"member_count": len(doc.users),
		"last_message": last_log.message if last_log else "",
		"last_time": last_log.creation if last_log else doc.creation,
		"last_from": last_log.from_user if last_log else None,
		"unread": count_group_unread(group, current_user),
		"is_admin": is_group_admin(group, current_user),
	}


# ----------------------------------------------------------------------
# API ENDPOINTS
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_chat_ui_settings():
	"""Public, non-sensitive widget appearance settings (icon/sound URLs) for the
	chat widget. Deliberately readable by any logged-in user, unlike the rest of
	Chat Settings (platform/model/api_key), which stays System-Manager-only.
	Only these two fields are ever returned — never the AI configuration."""
	settings = frappe.get_single("Chat Settings")
	return {
		"chat_icon": settings.chat_icon or None,
		"notification_sound": settings.notification_sound or None,
	}


@frappe.whitelist()
def search_users(txt: str = None, exclude_group: str = None):
	"""Search enabled Chat Users, returning all enabled users if search query is empty.

	If exclude_group is provided, users already in that group are left out of the
	results (used when adding members or picking members for a new group).
	"""
	txt = (txt or "").strip()
	current_user = frappe.session.user

	exclude_users = {current_user}
	if exclude_group and frappe.db.exists("Chat Group", exclude_group):
		exclude_users.update(get_group_member_names(exclude_group))

	filters = {"enabled": 1, "user": ["not in", list(exclude_users)]}
	or_filters = None

	if txt:
		or_filters = [
			["user", "like", f"%{txt}%"],
			["user_name", "like", f"%{txt}%"],
		]

	users = frappe.get_all(
		"Chat User",
		filters=filters,
		or_filters=or_filters,
		fields=["user", "user_name", "user_image", "enabled"],
		order_by="user_name asc",
		limit_page_length=50,
	)

	return [
		{
			"user": row.user,
			"full_name": row.user_name or row.user,
			"image": row.user_image,
			"enabled": row.enabled,
			"is_bot": False,
		}
		for row in users
	]


@frappe.whitelist()
def get_conversations():
	"""Fetch latest active conversations for current user."""
	current_user = frappe.session.user

	logs = frappe.db.sql(
		"""
		SELECT name, from_user, to_user, message, message_type, seen, creation
		FROM `tabChat Log`
		WHERE from_user = %(user)s OR to_user = %(user)s
		ORDER BY creation DESC
		LIMIT 500
		""",
		{"user": current_user},
		as_dict=True,
	)

	conversations = {}

	for log in logs:
		other_user = get_other_user(log)
		if not other_user or other_user in conversations:
			continue

		details = get_chat_user_details(other_user)
		if not details:
			continue

		unread = frappe.db.count(
			"Chat Log",
			{"from_user": other_user, "to_user": current_user, "seen": 0},
		)

		conversations[other_user] = {
			"user": other_user,
			"full_name": details["full_name"],
			"image": details["image"],
			"last_message": log.message,
			"last_time": log.creation,
			"unread": unread,
			"is_bot": details.get("is_bot", False),
			"enabled": details.get("enabled", 1),
		}

	return list(conversations.values())


@frappe.whitelist()
def get_messages(user: str):
	"""Fetch message history between active user and target user."""
	current_user = frappe.session.user

	if not user:
		frappe.throw(_("User parameter is required"))

	if user != NOTIFICATION_BOT_USER and not frappe.db.exists("Chat User", user):
		frappe.throw(_("Chat User not found: {0}").format(user))

	messages = frappe.db.sql(
		"""
		SELECT name, from_user, to_user, message_type, seen, seen_on, message, creation, modified
		FROM `tabChat Log`
		WHERE (from_user = %(current_user)s AND to_user = %(other_user)s)
		   OR (from_user = %(other_user)s AND to_user = %(current_user)s)
		ORDER BY creation ASC
		""",
		{"current_user": current_user, "other_user": user},
		as_dict=True,
	)

	attach_attachments_to_messages(messages)

	# Mark received messages as read
	frappe.db.set_value(
		"Chat Log",
		{"from_user": user, "to_user": current_user, "seen": 0},
		{"seen": 1, "seen_on": now_datetime()},
		update_modified=False,
	)
	frappe.db.commit()

	frappe.publish_realtime(
		"chat:seen",
		{"from_user": current_user, "to_user": user},
		user=user,
		after_commit=True,
	)

	return messages


@frappe.whitelist()
def send_message(to_user: str, message: str = "", attachments=None):
	"""Send a chat message (text and/or file attachments) to target user and emit realtime event."""
	current_user = frappe.session.user

	if current_user == "Guest":
		frappe.throw(_("Authentication required"))

	if not to_user:
		frappe.throw(_("Target recipient required"))

	if to_user == NOTIFICATION_BOT_USER:
		frappe.throw(_("Cannot reply to Notification Bot"))

	message = (message or "").strip()
	attachment_rows = build_attachment_rows(attachments)

	if not message and not attachment_rows:
		frappe.throw(_("Message body cannot be empty"))

	from_chat_user = ensure_chat_user(current_user)
	if not from_chat_user:
		frappe.throw(_("Chat User not initialized for {0}").format(current_user))

	to_chat_user = get_chat_user(to_user)
	if not to_chat_user:
		frappe.throw(_("Recipient Chat User not found: {0}").format(to_user))

	if not to_chat_user.enabled:
		frappe.throw(_("Selected recipient is disabled"))

	chat_log = frappe.get_doc(
		{
			"doctype": "Chat Log",
			"from_user": from_chat_user.name,
			"to_user": to_chat_user.name,
			"message_type": "Text",
			"seen": 0,
			"message": message,
			"attachments": attachment_rows,
		}
	)
	chat_log.insert(ignore_permissions=True)
	frappe.db.commit()

	relink_attachment_files([a["file_url"] for a in attachment_rows], chat_log.name)

	from_details = get_chat_user_details(current_user)
	to_details = get_chat_user_details(to_user)

	result = chat_log.as_dict()
	result["from_full_name"] = from_details["full_name"] if from_details else current_user
	result["to_full_name"] = to_details["full_name"] if to_details else to_user
	result["from_image"] = from_details["image"] if from_details else None
	result["to_image"] = to_details["image"] if to_details else None
	result["attachments"] = attachment_rows

	frappe.publish_realtime(
		"chat:new_message",
		result,
		user=to_chat_user.user,
		after_commit=True,
	)

	return result



@frappe.whitelist()
def get_unread_count():
	"""Get total unread message count for logged-in user, across direct chats and groups."""
	current_user = frappe.session.user
	direct_unread = frappe.db.count("Chat Log", {"to_user": current_user, "seen": 0}) or 0

	group_names = set(
		frappe.get_all(
			"Chat Group User",
			filters={"user": current_user, "parenttype": "Chat Group"},
			pluck="parent",
		)
	)
	group_unread = sum(count_group_unread(g, current_user) for g in group_names)

	return direct_unread + group_unread


@frappe.whitelist()
def mark_seen(user: str):
	"""Mark all unread messages from a specific user as seen."""
	current_user = frappe.session.user
	if not user:
		return 0

	messages = frappe.get_all(
		"Chat Log",
		filters={"from_user": user, "to_user": current_user, "seen": 0},
		pluck="name",
	)

	if not messages:
		return 0

	for name in messages:
		frappe.db.set_value(
			"Chat Log",
			name,
			{"seen": 1, "seen_on": now_datetime()},
			update_modified=False,
		)

	frappe.db.commit()

	frappe.publish_realtime(
		"chat:seen",
		{"from_user": current_user, "to_user": user},
		user=user,
		after_commit=True,
	)

	return len(messages)


@frappe.whitelist()
def set_typing(to_user: str):
	"""Emit typing indicator event to recipient."""
	current_user = frappe.session.user
	if not to_user or to_user == NOTIFICATION_BOT_USER:
		return

	frappe.publish_realtime(
		"chat:typing",
		{"from_user": current_user, "to_user": to_user},
		user=to_user,
	)


@frappe.whitelist()
def heartbeat():
	"""Record user presence active timestamp in cache."""
	current_user = frappe.session.user
	if current_user == "Guest":
		return False

	frappe.cache().set_value(
		f"chat_user_heartbeat:{current_user}",
		now_datetime().isoformat(),
		expires_in_sec=60,
	)
	return True


@frappe.whitelist()
def get_online_status(users=None):
	"""Query online presence status for a list of users."""
	if isinstance(users, str):
		try:
			users = frappe.parse_json(users)
		except Exception:
			users = [users]

	if not users:
		return {}

	result = {}
	for user in users:
		if not user:
			continue

		heartbeat_val = frappe.cache().get_value(f"chat_user_heartbeat:{user}")
		online = False

		if heartbeat_val:
			try:
				diff = (now_datetime() - get_datetime(heartbeat_val)).total_seconds()
				online = diff <= 60
			except Exception:
				online = False

		result[user] = online

	return result


@frappe.whitelist()
def create_group(group_name: str, users=None):
	"""Create a new Chat Group containing the current user and the given members."""
	current_user = frappe.session.user

	if current_user == "Guest":
		frappe.throw(_("Authentication required"))

	group_name = (group_name or "").strip()
	if not group_name:
		frappe.throw(_("Group name is required"))

	if isinstance(users, str):
		users = frappe.parse_json(users)
	users = users or []

	ensure_chat_user(current_user)

	member_set = {current_user}
	for u in users:
		if u and frappe.db.exists("Chat User", u):
			member_set.add(u)

	if len(member_set) < 2:
		frappe.throw(_("Select at least one other member to create a group"))

	group_doc = frappe.get_doc(
		{
			"doctype": "Chat Group",
			"group_name": group_name,
			"users": [
				{"user": u, "is_admin": 1 if u == current_user else 0}
				for u in member_set
			],
		}
	)
	group_doc.insert(ignore_permissions=True)
	frappe.db.commit()

	result = get_group_summary(group_doc.name, current_user)

	for member in member_set:
		if member == current_user:
			continue
		frappe.publish_realtime(
			"chat:group_created",
			result,
			user=member,
			after_commit=True,
		)

	return result


@frappe.whitelist()
def get_groups():
	"""Fetch all chat groups the current user belongs to, most recent first."""
	current_user = frappe.session.user

	group_names = set(
		frappe.get_all(
			"Chat Group User",
			filters={"user": current_user, "parenttype": "Chat Group"},
			pluck="parent",
		)
	)

	groups = [get_group_summary(g, current_user) for g in group_names]
	groups.sort(key=lambda g: str(g["last_time"] or ""), reverse=True)
	return groups


@frappe.whitelist()
def get_group_details(group: str):
	"""Fetch summary and member details for a single group."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_member(group, current_user):
		frappe.throw(_("You are not a member of this group"))

	return get_group_summary(group, current_user)


@frappe.whitelist()
def get_group_messages(group: str):
	"""Fetch message history for a group and mark it seen for the current user."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_member(group, current_user):
		frappe.throw(_("You are not a member of this group"))

	messages = frappe.db.sql(
		"""
		SELECT name, from_user, `group`, message_type, message, creation, modified
		FROM `tabChat Log`
		WHERE `group` = %(group)s
		ORDER BY creation ASC
		""",
		{"group": group},
		as_dict=True,
	)

	# Enrich each message with the sender's display name/image (cached per unique sender).
	details_cache = {}
	for msg in messages:
		sender = msg.from_user
		if sender not in details_cache:
			details_cache[sender] = get_chat_user_details(sender)
		details = details_cache[sender]
		msg["from_full_name"] = details["full_name"] if details else sender
		msg["from_image"] = details["image"] if details else None

	attach_attachments_to_messages(messages)

	mark_group_seen(group, current_user)

	for member in get_group_member_names(group):
		if member == current_user:
			continue
		frappe.publish_realtime(
			"chat:group_seen",
			{"group": group, "user": current_user},
			user=member,
			after_commit=True,
		)

	return messages


@frappe.whitelist()
def send_group_message(group: str, message: str = "", attachments=None):
	"""Send a message (text and/or file attachments) to a group and broadcast it to all members."""
	current_user = frappe.session.user

	if current_user == "Guest":
		frappe.throw(_("Authentication required"))

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_member(group, current_user):
		frappe.throw(_("You are not a member of this group"))

	message = (message or "").strip()
	attachment_rows = build_attachment_rows(attachments)

	if not message and not attachment_rows:
		frappe.throw(_("Message body cannot be empty"))

	from_chat_user = ensure_chat_user(current_user)
	if not from_chat_user:
		frappe.throw(_("Chat User not initialized for {0}").format(current_user))

	chat_log = frappe.get_doc(
		{
			"doctype": "Chat Log",
			"from_user": from_chat_user.name,
			"group": group,
			"message_type": "Group",
			"seen": 0,
			"message": message,
			"attachments": attachment_rows,
		}
	)
	chat_log.insert(ignore_permissions=True)
	frappe.db.commit()

	relink_attachment_files([a["file_url"] for a in attachment_rows], chat_log.name)

	from_details = get_chat_user_details(current_user)
	group_doc = frappe.get_doc("Chat Group", group)

	result = chat_log.as_dict()
	result["from_full_name"] = from_details["full_name"] if from_details else current_user
	result["from_image"] = from_details["image"] if from_details else None
	result["group_name"] = group_doc.group_name
	result["attachments"] = attachment_rows

	for member in [row.user for row in group_doc.users]:
		if member == current_user:
			continue
		frappe.publish_realtime(
			"chat:group_new_message",
			result,
			user=member,
			after_commit=True,
		)

	return result


@frappe.whitelist()
def add_group_members(group: str, users=None):
	"""Add one or more members to an existing group."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_member(group, current_user):
		frappe.throw(_("You are not a member of this group"))

	if isinstance(users, str):
		users = frappe.parse_json(users)
	users = users or []

	group_doc = frappe.get_doc("Chat Group", group)
	existing = {row.user for row in group_doc.users}
	added = []

	for u in users:
		if u and u not in existing and frappe.db.exists("Chat User", u):
			group_doc.append("users", {"user": u})
			existing.add(u)
			added.append(u)

	if added:
		group_doc.save(ignore_permissions=True)
		frappe.db.commit()

		result = get_group_summary(group, current_user)
		for member in [row.user for row in group_doc.users]:
			frappe.publish_realtime(
				"chat:group_updated",
				result,
				user=member,
				after_commit=True,
			)

	return get_group_summary(group, current_user)


@frappe.whitelist()
def rename_group(group: str, group_name: str):
	"""Rename a group. Admin-only."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can rename this group"))

	group_name = (group_name or "").strip()
	if not group_name:
		frappe.throw(_("Group name is required"))

	frappe.db.set_value("Chat Group", group, "group_name", group_name, update_modified=False)
	frappe.db.commit()

	result = get_group_summary(group, current_user)
	for member in get_group_member_names(group):
		frappe.publish_realtime("chat:group_updated", result, user=member, after_commit=True)

	return result


@frappe.whitelist()
def set_group_photo(group: str, image: str):
	"""Set or replace the group's photo. Admin-only. `image` is a file URL from upload_file."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can change the group photo"))

	image = (image or "").strip()
	if not image:
		frappe.throw(_("No image provided"))

	frappe.db.set_value("Chat Group", group, "group_image", image, update_modified=False)
	frappe.db.commit()

	result = get_group_summary(group, current_user)
	for member in get_group_member_names(group):
		frappe.publish_realtime("chat:group_updated", result, user=member, after_commit=True)

	return result


@frappe.whitelist()
def remove_group_photo(group: str):
	"""Remove the group's photo, reverting to the initials avatar. Admin-only."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can change the group photo"))

	frappe.db.set_value("Chat Group", group, "group_image", None, update_modified=False)
	frappe.db.commit()

	result = get_group_summary(group, current_user)
	for member in get_group_member_names(group):
		frappe.publish_realtime("chat:group_updated", result, user=member, after_commit=True)

	return result


@frappe.whitelist()
def make_group_admin(group: str, user: str):
	"""Promote a member to admin. Only existing admins can do this."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can promote members"))

	if not is_group_member(group, user):
		frappe.throw(_("User is not a member of this group"))

	frappe.db.set_value(
		"Chat Group User",
		{"parent": group, "parenttype": "Chat Group", "user": user},
		"is_admin",
		1,
		update_modified=False,
	)
	frappe.db.commit()

	result = get_group_summary(group, current_user)
	for member in get_group_member_names(group):
		frappe.publish_realtime("chat:group_updated", result, user=member, after_commit=True)

	return result


@frappe.whitelist()
def dismiss_group_admin(group: str, user: str):
	"""Demote an admin back to a regular member. A group must always keep at least one admin."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can change admin roles"))

	admin_count = frappe.db.count(
		"Chat Group User", {"parent": group, "parenttype": "Chat Group", "is_admin": 1}
	)
	if admin_count <= 1:
		frappe.throw(_("A group must have at least one admin"))

	frappe.db.set_value(
		"Chat Group User",
		{"parent": group, "parenttype": "Chat Group", "user": user},
		"is_admin",
		0,
		update_modified=False,
	)
	frappe.db.commit()

	result = get_group_summary(group, current_user)
	for member in get_group_member_names(group):
		frappe.publish_realtime("chat:group_updated", result, user=member, after_commit=True)

	return result


@frappe.whitelist()
def remove_group_member(group: str, user: str):
	"""Remove another member from the group. Admin-only; use leave_group to remove yourself."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can remove members"))

	if user == current_user:
		frappe.throw(_("Use 'Exit group' to remove yourself"))

	if not is_group_member(group, user):
		frappe.throw(_("User is not a member of this group"))

	group_doc = frappe.get_doc("Chat Group", group)
	group_doc.users = [row for row in group_doc.users if row.user != user]
	group_doc.save(ignore_permissions=True)
	frappe.db.commit()

	frappe.publish_realtime(
		"chat:group_member_removed",
		{"group": group, "user": user, "removed_by": current_user},
		user=user,
		after_commit=True,
	)

	result = get_group_summary(group, current_user)
	for member in [row.user for row in group_doc.users]:
		frappe.publish_realtime("chat:group_updated", result, user=member, after_commit=True)

	return result


@frappe.whitelist()
def delete_group(group: str):
	"""Permanently delete a group and its messages, notifying all members. Admin-only."""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_admin(group, current_user):
		frappe.throw(_("Only group admins can delete this group"))

	members = get_group_member_names(group)

	frappe.db.delete("Chat Log", {"group": group})
	frappe.delete_doc("Chat Group", group, ignore_permissions=True, force=True)
	frappe.db.commit()

	for member in members:
		frappe.publish_realtime(
			"chat:group_deleted",
			{"group": group},
			user=member,
			after_commit=True,
		)

	return {"ok": 1}


@frappe.whitelist()
def leave_group(group: str):
	"""Remove the current user from a group.

	If the leaving user was the sole admin, the next remaining member is promoted
	automatically so the group never ends up with zero admins. If they were the
	last member, the group (and its messages) are deleted outright.
	"""
	current_user = frappe.session.user

	if not group or not frappe.db.exists("Chat Group", group):
		frappe.throw(_("Group not found"))

	if not is_group_member(group, current_user):
		frappe.throw(_("You are not a member of this group"))

	group_doc = frappe.get_doc("Chat Group", group)
	was_admin = is_group_admin(group, current_user)

	remaining_rows = [row for row in group_doc.users if row.user != current_user]
	remaining_members = [row.user for row in remaining_rows]

	if not remaining_members:
		frappe.db.delete("Chat Log", {"group": group})
		frappe.delete_doc("Chat Group", group, ignore_permissions=True, force=True)
		frappe.db.commit()
		return {"ok": 1, "group_deleted": True}

	if was_admin and not any(row.is_admin for row in remaining_rows):
		remaining_rows[0].is_admin = 1

	group_doc.users = remaining_rows
	group_doc.save(ignore_permissions=True)
	frappe.db.commit()

	for member in remaining_members:
		frappe.publish_realtime(
			"chat:group_member_left",
			{"group": group, "user": current_user},
			user=member,
			after_commit=True,
		)

	return {"ok": 1}


@frappe.whitelist()
def group_mark_seen(group: str):
	"""Update the current user's last-seen timestamp for a group without refetching messages."""
	current_user = frappe.session.user

	if not group or not is_group_member(group, current_user):
		return 0

	mark_group_seen(group, current_user)

	for member in get_group_member_names(group):
		if member == current_user:
			continue
		frappe.publish_realtime(
			"chat:group_seen",
			{"group": group, "user": current_user},
			user=member,
			after_commit=True,
		)

	return 1


def handle_notification_log(doc, method=None):
	"""DocType hook handler for systemic notification broadcast."""
	message = strip_html(f"{doc.title or ''}\n\n{doc.description or ''}")

	chat_doc = frappe.get_doc(
		{
			"doctype": "Chat Log",
			"from_user": NOTIFICATION_BOT_USER,
			"to_user": doc.for_user,
			"message": message,
			"message_type": "Notification",
		}
	).insert(ignore_permissions=True)

	payload = {
		"name": chat_doc.name,
		"from_user": NOTIFICATION_BOT_USER,
		"to_user": doc.for_user,
		"from_full_name": "Notification Bot",
		"message": chat_doc.message,
		"message_type": "Notification",
		"creation": chat_doc.creation,
		"is_bot": True,
	}

	frappe.publish_realtime(
		"chat:new_message",
		payload,
		user=doc.for_user,
		after_commit=True,
	)
 
def update_chat_user(doc, action):
    chat_user = frappe.db.exists("Chat User", doc.name)
    
    if chat_user:
        frappe.db.set_value("Chat User", chat_user, {
			"user_name": doc.full_name,
			"user_image": doc.user_image,
			"enabled": doc.enabled
		})