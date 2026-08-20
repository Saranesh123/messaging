import frappe

def after_install():
   user = create_notification_bot()
   
   if user:
       create_chat_user(user)
    
def create_notification_bot():
    user = frappe.get_doc({
        "doctype": "User",
        "email": "notifications-bot@example.com",
        "enabled": 1,
        "first_name": "Notifications Bot"
    }).insert(ignore_permissions=True, ignore_mandatory=True, ignore_if_duplicate=True)
    
    return user.name if user else None

def create_chat_user(user):
    user = frappe.get_doc("User", user)
    
    frappe.get_doc({
        "doctype": "Chat User",
        "user": user.name,
        "user_name": user.full_name,
        "enabled": 1
    }).insert(ignore_permissions=True, ignore_mandatory=True, ignore_if_duplicate=True)