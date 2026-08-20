# Copyright (c) 2026, SARANESH A & TANIA MONDAL and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class ChatLog(Document):
	def validate(self):
		if self.from_user != frappe.session.user:
			frappe.throw("You can only send messages as yourself.")
 
def get_permission_query_conditions(user):
	if not user:
		user = frappe.session.user
  
	return f"""(`tabChat Log`.from_user = {frappe.db.escape(user)}
		or `tabChat Log`.to_user = {frappe.db.escape(user)})"""
 
 
def has_permission(doc, user=None, permission_type=None):
	if not user:
		user = frappe.session.user
	
	return doc.from_user == user or doc.to_user == user