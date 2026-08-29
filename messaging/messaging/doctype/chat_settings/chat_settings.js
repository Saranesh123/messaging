// Copyright (c) 2026, SARANESH A and contributors
// For license information, please see license.txt

frappe.ui.form.on("Chat Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Test AI Connection"), () => {
			frappe.call({
				method: "messaging.ai.test_ai_connection",
				freeze: true,
				freeze_message: __("Testing connection..."),
			}).then((r) => {
				if (r.message && r.message.ok) {
					frappe.msgprint({
						title: __("Connection Successful"),
						indicator: "green",
						message: __("AI replied: {0}", [frappe.utils.escape_html(r.message.reply)]),
					});
				}
			});
		});
	},
});