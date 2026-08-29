# Copyright (c) 2026, SARANESH A and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class ChatLog(Document):
	def validate(self):
		if self.from_user == "notifications-bot@example.com":
			return

		if self.from_user != frappe.session.user:
			frappe.throw("You can only send messages as yourself.")
   
	# def get_permission_query_conditions(user):
	# 	if not user:
	# 		user = frappe.session.user

	# 	user = frappe.db.escape(user)

	# 	return f"""
	# 		(`tabChat Log`.from_user = {user}
	# 		OR `tabChat Log`.to_user = {user})
	# 	"""


	# def has_permission(doc, user):
	# 	if not user:
	# 		user = frappe.session.user

	# 	if doc.from_user == user or doc.to_user == user:
	# 		return True

	# 	return False