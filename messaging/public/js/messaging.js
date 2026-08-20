// chat_widget.js
// Drop into your_app/public/js/chat_widget.js and add to hooks.py -> app_include_js
//
// Replace "your_app" below with your actual app module path if you rename
// chat_api.py's location.

const CHAT_API = "messaging.api";

frappe.provide("your_app.chat");

your_app.chat = {
	state: {
		open: false,
		view: "list", // "list" | "thread" | "search"
		activeUser: null,
		conversations: [],
		messages: [],
		unread: 0,
		presencePollTimer: null,
		heartbeatTimer: null,
	},

	init() {
		if (frappe.session.user === "Guest") return;
		this.buildDom();
		this.bindEvents();
		this.bindRealtime();
		this.refreshUnread();
		this.startHeartbeat();
	},

	buildDom() {
		this.$root = $(`
			<div class="fchat-root">
				<button class="fchat-bubble" title="Messaging">
					<svg viewBox="0 0 24 24" class="fchat-bubble-icon"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>
					<span class="fchat-badge" style="display:none;">0</span>
				</button>

				<div class="fchat-panel">
					<div class="fchat-header">
						<div class="fchat-header-left">
							<span class="fchat-header-back" style="display:none;">
								<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
							</span>
							<span class="fchat-header-avatar" style="display:none;"></span>
							<div class="fchat-header-title">
								<span class="fchat-header-name">Messaging</span>
								<span class="fchat-header-status"></span>
							</div>
						</div>
						<div class="fchat-header-actions">
							<button class="fchat-new-btn" title="New message">
								<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
							</button>
							<button class="fchat-close-btn" title="Close">
								<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
							</button>
						</div>
					</div>

					<div class="fchat-search-bar" style="display:none;">
						<input type="text" class="fchat-search-input" placeholder="Search people..." />
					</div>

					<div class="fchat-body">
						<div class="fchat-list"></div>
						<div class="fchat-search-results" style="display:none;"></div>
						<div class="fchat-thread" style="display:none;">
							<div class="fchat-thread-messages"></div>
							<div class="fchat-typing-indicator" style="display:none;">typing...</div>
						</div>
					</div>

					<div class="fchat-composer" style="display:none;">
						<input type="text" class="fchat-composer-input" placeholder="Write a message..." />
						<button class="fchat-send-btn">
							<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
						</button>
					</div>
				</div>
			</div>
		`);
		$("body").append(this.$root);
	},

	bindEvents() {
		const s = this.state;

		this.$root.find(".fchat-bubble").on("click", () => this.togglePanel());
		this.$root.find(".fchat-close-btn").on("click", () => this.togglePanel(false));

		this.$root.find(".fchat-new-btn").on("click", () => this.showSearch());
		this.$root.find(".fchat-header-back").on("click", () => {
			if (s.view === "search") this.showList();
			else if (s.view === "thread") this.showList();
		});

		let searchTimeout;
		this.$root.find(".fchat-search-input").on("input", (e) => {
			clearTimeout(searchTimeout);
			const txt = $(e.target).val();
			searchTimeout = setTimeout(() => this.runSearch(txt), 250);
		});

		this.$root.find(".fchat-send-btn").on("click", () => this.sendCurrentMessage());
		this.$root.find(".fchat-composer-input").on("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendCurrentMessage();
			} else {
				this.notifyTyping();
			}
		});

		$(window).on("focus", () => this.heartbeat());
	},

	bindRealtime() {
		frappe.realtime.on("chat:new_message", (data) => this.onNewMessage(data));
		frappe.realtime.on("chat:seen", (data) => this.onSeen(data));
		frappe.realtime.on("chat:typing", (data) => this.onTyping(data));
	},

	// ---------------------------------------------------------------- panel
	togglePanel(force) {
		const s = this.state;
		s.open = force !== undefined ? force : !s.open;
		this.$root.find(".fchat-panel").toggleClass("fchat-panel-open", s.open);
		if (s.open) {
			this.showList();
		} else {
			this.stopPresencePoll();
		}
	},

	showList() {
		const s = this.state;
		s.view = "list";
		s.activeUser = null;
		this.$root.find(".fchat-header-back, .fchat-header-avatar").hide();
		this.$root.find(".fchat-header-name").text("Messaging");
		this.$root.find(".fchat-header-status").text("");
		this.$root.find(".fchat-search-bar").hide();
		this.$root.find(".fchat-list").show();
		this.$root.find(".fchat-search-results, .fchat-thread, .fchat-composer").hide();
		this.loadConversations();
	},

	showSearch() {
		const s = this.state;
		s.view = "search";
		this.$root.find(".fchat-header-back").show();
		this.$root.find(".fchat-header-avatar").hide();
		this.$root.find(".fchat-header-name").text("New message");
		this.$root.find(".fchat-header-status").text("");
		this.$root.find(".fchat-search-bar").show();
		this.$root.find(".fchat-search-input").val("").focus();
		this.$root.find(".fchat-list, .fchat-thread, .fchat-composer").hide();
		this.$root.find(".fchat-search-results").show().empty();
	},

	openThread(user, fullName, image) {
		const s = this.state;
		s.view = "thread";
		s.activeUser = user;

		this.$root.find(".fchat-header-back").show();
		this.$root.find(".fchat-header-avatar")
			.show()
			.html(this.avatarHtml(fullName, image, user));
		this.$root.find(".fchat-header-name").text(fullName || user);
		this.$root.find(".fchat-search-bar").hide();
		this.$root.find(".fchat-list, .fchat-search-results").hide();
		this.$root.find(".fchat-thread, .fchat-composer").show();
		this.$root.find(".fchat-composer-input").val("").focus();

		this.loadMessages(user);
		this.startPresencePoll([user]);
	},

	// ------------------------------------------------------------ data ops
	loadConversations() {
		frappe.call({ method: `${CHAT_API}.get_conversations` }).then((r) => {
			const list = r.message || [];
			this.state.conversations = list;
			this.renderList(list);
			this.startPresencePoll(list.map((c) => c.user));
		});
	},

	renderList(list) {
		const $list = this.$root.find(".fchat-list").empty();
		if (!list.length) {
			$list.append(`<div class="fchat-empty">No conversations yet. Tap + to start one.</div>`);
			return;
		}
		list.forEach((c) => {
			const $row = $(`
				<div class="fchat-row ${c.unread ? "fchat-row-unread" : ""}" data-user="${frappe.utils.escape_html(c.user)}">
					<span class="fchat-avatar-wrap">
						${this.avatarHtml(c.full_name, c.image, c.user, c.is_bot)}
						<span class="fchat-presence-dot" data-presence-for="${frappe.utils.escape_html(c.user)}"></span>
					</span>
					<div class="fchat-row-body">
						<div class="fchat-row-top">
							<span class="fchat-row-name">${frappe.utils.escape_html(c.full_name || c.user)}</span>
							<span class="fchat-row-time">${comment_when(c.last_time)}</span>
						</div>
						<div class="fchat-row-preview">${frappe.utils.escape_html((c.last_message || "").slice(0, 60))}</div>
					</div>
					${c.unread ? `<span class="fchat-row-badge">${c.unread}</span>` : ""}
				</div>
			`);
			$row.on("click", () => this.openThread(c.user, c.full_name, c.image));
			$list.append($row);
		});
	},

	runSearch(txt) {
		frappe.call({ method: `${CHAT_API}.search_users`, args: { txt } }).then((r) => {
			const $res = this.$root.find(".fchat-search-results").empty();
			(r.message || []).forEach((u) => {
				const $row = $(`
					<div class="fchat-row">
						<span class="fchat-avatar-wrap">${this.avatarHtml(u.full_name, u.image, u.user)}</span>
						<div class="fchat-row-body">
							<div class="fchat-row-top"><span class="fchat-row-name">${frappe.utils.escape_html(u.full_name || u.user)}</span></div>
							<div class="fchat-row-preview">${frappe.utils.escape_html(u.user)}</div>
						</div>
					</div>
				`);
				$row.on("click", () => this.openThread(u.user, u.full_name, u.image));
				$res.append($row);
			});
			if (!(r.message || []).length) {
				$res.append(`<div class="fchat-empty">No people found</div>`);
			}
		});
	},

	loadMessages(user) {
		frappe.call({ method: `${CHAT_API}.get_messages`, args: { user } }).then((r) => {
			this.state.messages = r.message || [];
			this.renderThread();
			this.refreshUnread();
		});
	},

	renderThread() {
		const $wrap = this.$root.find(".fchat-thread-messages").empty();
		let lastDay = null;
		this.state.messages.forEach((m) => {
			const day = frappe.datetime.str_to_user(m.creation).split(" ")[0];
			if (day !== lastDay) {
				$wrap.append(`<div class="fchat-day-sep">${frappe.datetime.comment_when(m.creation, true)}</div>`);
				lastDay = day;
			}
			const mine = m.from_user === frappe.session.user;
			const bot = m.message_type === "Notification";
			$wrap.append(`
				<div class="fchat-msg ${mine ? "fchat-msg-mine" : "fchat-msg-theirs"} ${bot ? "fchat-msg-bot" : ""}">
					<div class="fchat-msg-bubble">${frappe.utils.escape_html(m.message)}</div>
					<div class="fchat-msg-time">${frappe.datetime.str_to_user(m.creation).split(" ")[1] || ""}</div>
				</div>
			`);
		});
		$wrap.scrollTop($wrap[0].scrollHeight);
	},

	sendCurrentMessage() {
		const s = this.state;
		const $input = this.$root.find(".fchat-composer-input");
		const message = $input.val();
		if (!message || !message.trim() || !s.activeUser) return;
		$input.val("");

		frappe.call({
			method: `${CHAT_API}.send_message`,
			args: { to_user: s.activeUser, message },
		}).then((r) => {
			if (r.message) {
				this.state.messages.push(r.message);
				this.renderThread();
			}
		});
	},

	notifyTyping: frappe.utils.debounce(function () {
		const s = your_app.chat.state;
		if (s.activeUser) {
			frappe.call({ method: `${CHAT_API}.set_typing`, args: { to_user: s.activeUser } });
		}
	}, 800),

	// --------------------------------------------------------- realtime in
	onNewMessage(data) {
		const s = this.state;
		const me = frappe.session.user;
		const otherParty = data.from_user === me ? data.to_user : data.from_user;

		if (s.open && s.view === "thread" && s.activeUser === otherParty) {
			s.messages.push(data);
			this.renderThread();
			if (data.to_user === me) {
				frappe.call({ method: `${CHAT_API}.get_messages`, args: { user: otherParty } });
			}
		} else if (data.to_user === me) {
			this.showToast(data);
			this.bumpBadge();
		}

		if (s.open && s.view === "list") this.loadConversations();
	},

	onSeen(data) {
		// could add read-receipt ticks here (✓✓) if desired
	},

	onTyping(data) {
		const s = this.state;
		if (s.activeUser === data.from_user) {
			const $ind = this.$root.find(".fchat-typing-indicator").show();
			clearTimeout(this._typingTimeout);
			this._typingTimeout = setTimeout(() => $ind.hide(), 2000);
		}
	},

	showToast(data) {
		const name = data.from_user === "notification-bot@yoursite.local" ? "Notification Bot" : data.from_user;
		const $toast = $(`
			<div class="fchat-toast">
				<div class="fchat-toast-title">${frappe.utils.escape_html(name)}</div>
				<div class="fchat-toast-msg">${frappe.utils.escape_html((data.message || "").slice(0, 80))}</div>
			</div>
		`);
		$toast.on("click", () => {
			this.togglePanel(true);
			this.openThread(data.from_user);
			$toast.remove();
		});
		$("body").append($toast);
		requestAnimationFrame(() => $toast.addClass("fchat-toast-in"));
		setTimeout(() => {
			$toast.removeClass("fchat-toast-in");
			setTimeout(() => $toast.remove(), 300);
		}, 5000);
	},

	// ------------------------------------------------------------- badges
	refreshUnread() {
		frappe.call({ method: `${CHAT_API}.get_unread_count` }).then((r) => {
			this.state.unread = r.message || 0;
			this.renderBadge();
		});
	},

	bumpBadge() {
		this.state.unread += 1;
		this.renderBadge();
	},

	renderBadge() {
		const $b = this.$root.find(".fchat-badge");
		if (this.state.unread > 0) {
			$b.text(this.state.unread > 99 ? "99+" : this.state.unread).show();
			this.$root.find(".fchat-bubble").addClass("fchat-bubble-pulse");
		} else {
			$b.hide();
			this.$root.find(".fchat-bubble").removeClass("fchat-bubble-pulse");
		}
	},

	// ----------------------------------------------------------- presence
	startHeartbeat() {
		this.heartbeat();
		this.state.heartbeatTimer = setInterval(() => this.heartbeat(), 30000);
	},

	heartbeat() {
		frappe.call({ method: `${CHAT_API}.heartbeat` });
	},

	startPresencePoll(users) {
		this.stopPresencePoll();
		const poll = () => {
			if (!users.length) return;
			frappe.call({ method: `${CHAT_API}.get_online_status`, args: { users } }).then((r) => {
				const statuses = r.message || {};
				Object.keys(statuses).forEach((u) => {
					const online = statuses[u];
					this.$root.find(`.fchat-presence-dot[data-presence-for="${u}"]`)
						.toggleClass("fchat-online", online)
						.toggleClass("fchat-offline", !online);
					if (this.state.activeUser === u) {
						this.$root.find(".fchat-header-status").text(online ? "Active now" : "Offline");
					}
				});
			});
		};
		poll();
		this.state.presencePollTimer = setInterval(poll, 20000);
	},

	stopPresencePoll() {
		if (this.state.presencePollTimer) clearInterval(this.state.presencePollTimer);
	},

	// -------------------------------------------------------------- utils
	avatarHtml(fullName, image, user, isBot) {
		if (isBot) {
			return `<span class="fchat-avatar fchat-avatar-bot">🤖</span>`;
		}
		if (image) {
			return `<img class="fchat-avatar" src="${frappe.utils.escape_html(image)}" />`;
		}
		const initial = (fullName || user || "?").trim().charAt(0).toUpperCase();
		return `<span class="fchat-avatar fchat-avatar-fallback">${initial}</span>`;
	},
};

function comment_when(dt) {
	try {
		return frappe.datetime.comment_when(dt);
	} catch (e) {
		return "";
	}
}

$(document).ready(() => {
	frappe.after_ajax(() => your_app.chat.init());
});