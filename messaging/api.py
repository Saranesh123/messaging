import frappe
from frappe import _
from frappe.utils import now_datetime, get_datetime


# ----------------------------------------------------------------------
# HELPERS
# ----------------------------------------------------------------------

def get_chat_user(user):
    """
    Return Chat User document for a Frappe User.

    Chat User uses:
        autoname = field:user

    Therefore:
        Chat User.name == Chat User.user
    """

    if not user:
        return None

    if not frappe.db.exists("Chat User", user):
        return None

    return frappe.get_doc("Chat User", user)


def ensure_chat_user(user):
    """
    Make sure a Frappe User has a Chat User record.
    """

    if not user or user == "Guest":
        return None

    if frappe.db.exists("Chat User", user):
        return frappe.get_doc("Chat User", user)

    frappe_user = frappe.db.get_value(
        "User",
        user,
        [
            "name",
            "full_name",
            "user_image",
            "enabled",
            "user_type",
        ],
        as_dict=True,
    )

    if not frappe_user:
        return None

    if frappe_user.user_type != "System User":
        return None

    if not frappe_user.enabled:
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


def get_chat_user_details(user):
    """
    Return display information for a Chat User.
    """

    if not user:
        return None

    row = frappe.db.get_value(
        "Chat User",
        user,
        [
            "user",
            "user_name",
            "user_image",
            "enabled",
        ],
        as_dict=True,
    )

    if not row:
        return None

    return {
        "user": row.user,
        "full_name": row.user_name or row.user,
        "image": row.user_image,
        "enabled": row.enabled,
    }


def get_other_user(log):
    """
    Return the other Chat User in a conversation.
    """

    current_user = frappe.session.user

    if log.from_user == current_user:
        return log.to_user

    return log.from_user


# ----------------------------------------------------------------------
# SEARCH USERS
# ----------------------------------------------------------------------

@frappe.whitelist()
def search_users(txt=None):
    """
    Search Chat Users.

    IMPORTANT:
    The returned `user` is the actual Chat User name.

    Since Chat User uses:
        autoname = field:user

    this is also the Frappe User ID.

    Example:

        {
            "user": "tania.mondal@example.com",
            "full_name": "Tania Mondal"
        }

    The UI displays full_name but sends user.
    """

    txt = (txt or "").strip()

    if not txt:
        return []

    current_user = frappe.session.user

    filters = {
        "enabled": 1,
        "user": ["!=", current_user],
    }

    or_filters = [
        ["user", "like", f"%{txt}%"],
        ["user_name", "like", f"%{txt}%"],
    ]

    users = frappe.get_all(
        "Chat User",
        filters=filters,
        or_filters=or_filters,
        fields=[
            "user",
            "user_name",
            "user_image",
            "enabled",
        ],
        order_by="user_name asc",
        limit_page_length=20,
    )

    return [
        {
            # THIS IS THE IMPORTANT VALUE
            # This must be Chat User.name / User ID.
            "user": row.user,

            # Display only
            "full_name": row.user_name or row.user,

            # Display only
            "image": row.user_image,

            "enabled": row.enabled,
        }
        for row in users
    ]


# ----------------------------------------------------------------------
# GET CONVERSATIONS
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_conversations():
    """
    Return conversations for the current user.
    """

    current_user = frappe.session.user

    logs = frappe.get_all(
        "Chat Log",
        filters=[
            [
                "Chat Log",
                "from_user",
                "=",
                current_user,
            ],
        ],
        or_filters=[
            [
                "Chat Log",
                "to_user",
                "=",
                current_user,
            ],
            [
                "Chat Log",
                "from_user",
                "=",
                current_user,
            ],
        ],
        fields=[
            "name",
            "from_user",
            "to_user",
            "message",
            "message_type",
            "seen",
            "creation",
        ],
        order_by="creation desc",
        limit_page_length=500,
    )

    # The above OR filtering can vary depending on Frappe version.
    # Use a direct query to reliably get both directions.
    logs = frappe.db.sql(
        """
        SELECT
            name,
            from_user,
            to_user,
            message,
            message_type,
            seen,
            creation
        FROM `tabChat Log`
        WHERE
            from_user = %(user)s
            OR to_user = %(user)s
        ORDER BY creation DESC
        LIMIT 500
        """,
        {
            "user": current_user,
        },
        as_dict=True,
    )

    conversations = {}

    for log in logs:
        other_user = get_other_user(log)

        if not other_user:
            continue

        if other_user in conversations:
            continue

        details = get_chat_user_details(other_user)

        if not details:
            continue

        # Count unread messages from this user
        unread = frappe.db.count(
            "Chat Log",
            {
                "from_user": other_user,
                "to_user": current_user,
                "seen": 0,
            },
        )

        conversations[other_user] = {
            # IMPORTANT:
            # This is the actual Chat User name.
            "user": other_user,

            "full_name": details["full_name"],
            "image": details["image"],

            "last_message": log.message,
            "last_time": log.creation,

            "unread": unread,

            "is_bot": False,
        }

    return list(conversations.values())


# ----------------------------------------------------------------------
# GET MESSAGES
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_messages(user):
    """
    Get messages between current user and selected Chat User.
    """

    current_user = frappe.session.user

    if not user:
        frappe.throw(_("User is required"))

    # Make sure selected user actually exists.
    if not frappe.db.exists("Chat User", user):
        frappe.throw(
            _("Could not find Chat User: {0}").format(user)
        )

    messages = frappe.db.sql(
        """
        SELECT
            name,
            from_user,
            to_user,
            message_type,
            seen,
            seen_on,
            message,
            creation,
            modified
        FROM `tabChat Log`
        WHERE
            (
                from_user = %(current_user)s
                AND to_user = %(other_user)s
            )
            OR
            (
                from_user = %(other_user)s
                AND to_user = %(current_user)s
            )
        ORDER BY creation ASC
        """,
        {
            "current_user": current_user,
            "other_user": user,
        },
        as_dict=True,
    )

    # Mark received messages as seen
    frappe.db.set_value(
        "Chat Log",
        {
            "from_user": user,
            "to_user": current_user,
            "seen": 0,
        },
        {
            "seen": 1,
            "seen_on": now_datetime(),
        },
        update_modified=False,
    )

    frappe.db.commit()

    return messages


# ----------------------------------------------------------------------
# SEND MESSAGE
# ----------------------------------------------------------------------

@frappe.whitelist()
def send_message(to_user, message):
    """
    Send a message to another Chat User.

    `to_user` MUST be Chat User.name.

    Because Chat User uses:
        autoname = field:user

    Chat User.name is the User ID.
    """

    current_user = frappe.session.user

    if current_user == "Guest":
        frappe.throw(_("You must be logged in"))

    if not to_user:
        frappe.throw(_("To User is required"))

    message = (message or "").strip()

    if not message:
        frappe.throw(_("Message cannot be empty"))

    # --------------------------------------------------------------
    # IMPORTANT VALIDATION
    # --------------------------------------------------------------

    from_chat_user = ensure_chat_user(current_user)

    if not from_chat_user:
        frappe.throw(
            _("Could not find Chat User for current user: {0}")
            .format(current_user)
        )

    # The selected value from JS should be Chat User.name.
    to_chat_user = get_chat_user(to_user)

    if not to_chat_user:
        frappe.throw(
            _("Could not find To User: {0}").format(to_user)
        )

    if not to_chat_user.enabled:
        frappe.throw(
            _("The selected user is disabled")
        )

    # --------------------------------------------------------------
    # CREATE CHAT LOG
    # --------------------------------------------------------------

    chat_log = frappe.get_doc(
        {
            "doctype": "Chat Log",

            # Chat User.name
            "from_user": from_chat_user.name,

            # Chat User.name
            "to_user": to_chat_user.name,

            "message_type": "Text",

            "seen": 0,

            "message": message,
        }
    )

    chat_log.insert(ignore_permissions=True)

    frappe.db.commit()

    result = chat_log.as_dict()

    # Add display information
    result["from_full_name"] = (
        from_chat_user.user_name
        or from_chat_user.user
    )

    result["to_full_name"] = (
        to_chat_user.user_name
        or to_chat_user.user
    )

    result["from_image"] = from_chat_user.user_image
    result["to_image"] = to_chat_user.user_image

    # --------------------------------------------------------------
    # REALTIME
    # --------------------------------------------------------------

    frappe.publish_realtime(
        "chat:new_message",
        result,
        user=to_chat_user.user,
        after_commit=True,
    )

    return result


# ----------------------------------------------------------------------
# UNREAD COUNT
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_unread_count():
    """
    Total unread messages for current user.
    """

    current_user = frappe.session.user

    count = frappe.db.count(
        "Chat Log",
        {
            "to_user": current_user,
            "seen": 0,
        },
    )

    return count or 0


# ----------------------------------------------------------------------
# MARK AS SEEN
# ----------------------------------------------------------------------

@frappe.whitelist()
def mark_seen(user):
    """
    Mark messages from selected Chat User as seen.
    """

    current_user = frappe.session.user

    if not user:
        return 0

    if not frappe.db.exists("Chat User", user):
        frappe.throw(
            _("Could not find Chat User: {0}").format(user)
        )

    messages = frappe.get_all(
        "Chat Log",
        filters={
            "from_user": user,
            "to_user": current_user,
            "seen": 0,
        },
        pluck="name",
    )

    if not messages:
        return 0

    for name in messages:
        frappe.db.set_value(
            "Chat Log",
            name,
            {
                "seen": 1,
                "seen_on": now_datetime(),
            },
            update_modified=False,
        )

    frappe.db.commit()

    frappe.publish_realtime(
        "chat:seen",
        {
            "from_user": current_user,
            "to_user": user,
        },
        user=user,
        after_commit=True,
    )

    return len(messages)


# ----------------------------------------------------------------------
# TYPING
# ----------------------------------------------------------------------

@frappe.whitelist()
def set_typing(to_user):
    """
    Notify another Chat User that current user is typing.
    """

    current_user = frappe.session.user

    if not to_user:
        return

    if not frappe.db.exists("Chat User", to_user):
        frappe.throw(
            _("Could not find To User: {0}").format(to_user)
        )

    frappe.publish_realtime(
        "chat:typing",
        {
            "from_user": current_user,
            "to_user": to_user,
        },
        user=to_user,
    )


# ----------------------------------------------------------------------
# HEARTBEAT
# ----------------------------------------------------------------------

@frappe.whitelist()
def heartbeat():
    """
    Update user's last activity time.

    No field needs to be added to Chat User.
    Uses Frappe cache instead.
    """

    current_user = frappe.session.user

    if current_user == "Guest":
        return False

    cache_key = f"chat_user_heartbeat:{current_user}"

    frappe.cache().set_value(
        cache_key,
        now_datetime().isoformat(),
        expires_in_sec=60,
    )

    return True


# ----------------------------------------------------------------------
# ONLINE STATUS
# ----------------------------------------------------------------------

@frappe.whitelist()
def get_online_status(users=None):
    """
    Return online/offline status.

    Uses cache heartbeat.
    """

    current_user = frappe.session.user

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

        cache_key = f"chat_user_heartbeat:{user}"

        heartbeat = frappe.cache().get_value(
            cache_key
        )

        online = False

        if heartbeat:
            try:
                heartbeat_dt = get_datetime(heartbeat)

                diff = (
                    now_datetime() - heartbeat_dt
                ).total_seconds()

                online = diff <= 60

            except Exception:
                online = False

        result[user] = online

    return result