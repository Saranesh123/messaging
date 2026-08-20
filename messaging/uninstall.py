import frappe

def before_uninstall():
    if frappe.db.exists("User", "notifications-bot@example.com"):
        frappe.delete_doc("User", "notifications-bot@example.com", force=1)