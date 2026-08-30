
const CHAT_API = "messaging.api";
const CHAT_API_AI = "messaging.ai";
const CHAT_API_AI_FEATURES = "messaging.ai_features";
const NOTIFICATION_AUDIO_PATH = "/assets/messaging/sounds/notification.mp3";
const NOTIFICATION_BOT_USER = "notifications-bot@example.com";

frappe.provide("messaging.chat");

function formatChatDate(timestamp) {
    if (!timestamp) return "";
    const msgDate = frappe.datetime.str_to_obj(timestamp);
    const now = new Date();

    // Reset time components for accurate day comparison
    const d1 = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());
    const d2 = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const diffTime = d2 - d1;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";

    // WhatsApp Style: Show Day name if within the last 7 days
    if (diffDays > 1 && diffDays < 7) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
"Saturday"];
        return days[msgDate.getDay()];
    }

    // Older than 7 days: Show formatted date e.g., "11 Aug 2026"
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov",
"Dec"];
    return `${msgDate.getDate()} ${months[msgDate.getMonth()]} ${msgDate.getFullYear()}`;
}

function formatMsgTime(timestamp) {
    if (!timestamp) return "";
    const msgDate = frappe.datetime.str_to_obj(timestamp);
    let hours = msgDate.getHours();
    let minutes = msgDate.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    return `${hours}:${minutes} ${ampm}`;
}

messaging.chat = {
    state: {
        open: false,
        view: "list",
        activeUser: null,
        activeUserData: {},
        conversations: [],
        groups: [],
        messages: [],
        unread: 0,
        presencePollTimer: null,
        heartbeatTimer: null,
        userPresence: 'active', // 'active' | 'idle'
        idleTimeoutTimer: null,

        // Group-specific state
        activeGroup: null,
        activeGroupData: {},
        activeIsGroup: false,
        groupSelection: new Map(), // user -> {full_name, image, is_bot}

        // Attachments pending in the composer, not yet sent
        pendingAttachments: [],
        groupSetupMode: "create", // 'create' | 'add'

        // AI feature state
        aiFeatures: {}, // feature_key -> bool, loaded once at init
        askAiMessages: [], // {question, answer, loading, error} — per-thread Ask AI history
        askAiReturnView: "thread", // 'thread' | 'groupThread' | 'list' — where "back" from Ask AI goes
        askAiMode: "thread", // 'thread' | 'global' | 'erpnext' — which panel content/backend the shared Ask AI UI uses
        chatSearchMessages: [], // same shape as askAiMessages, but for the global "Ask AI about your chats" search
        erpnextAiMessages: [], // same shape as askAiMessages, for permission-aware ERPNext search
    },

    audio: null,
    audioUnlocked: false,

    init() {
        if (frappe.session.user === "Guest" || this._initialized) {
            return;
        }

        this._initialized = true;

        this.initAudio(); // bind unlock listeners immediately, before any network round-trip
        this.buildDom();
        this.bindEvents();
        this.bindRealtime();
        this.bindActivityListeners();
        this.refreshUnread();
        this.startHeartbeat();

        this.loadChatUISettings();
        this.loadAIFeatureFlags();
    },

    loadAIFeatureFlags() {
        frappe.call({
            method: `${CHAT_API_AI}.get_ai_feature_flags`,
        }).then((r) => {
            this.state.aiFeatures = r.message || {};
            this.refreshAIVisibility();
        }).catch(() => {
            this.state.aiFeatures = {};
        });
    },

    loadChatUISettings() {
        frappe.call({
            method: `${CHAT_API}.get_chat_ui_settings`,
        }).then((r) => {
            const settings = r.message || {};
            this.applyNotificationSound(settings.notification_sound);
            this.applyChatIcon(settings.chat_icon);
        }).catch(() => {
            // Settings couldn't be fetched (e.g. site not yet configured) —
            // the default sound/icon set up in initAudio()/buildDom() stays active.
        });
    },

    applyChatIcon(iconUrl) {
        if (!iconUrl) return; // default SVG already sits in the DOM, nothing to do

        const $bubble = this.$root.find(".fchat-bubble");
        $bubble.find(".fchat-bubble-icon").remove();
        $bubble.prepend(
            `<img class="fchat-bubble-custom-icon" src="${frappe.utils.escape_html(iconUrl)}"alt="Messaging" />`
        );
    },

    applyNotificationSound(src) {
        if (!src || !this.audio) return;
        // Swap the source in place rather than creating a new Audio object —
        // the unlock listeners bound in initAudio() reference this.audio // directly, and a fresh object would need to be unlocked all over again.
        this.audio.src = src;
        this.audio.load();
    },

    initAudio() {
        if (!NOTIFICATION_AUDIO_PATH) return;

        this.audio = new Audio(NOTIFICATION_AUDIO_PATH);
        this.audio.preload = "auto";

        const unlock = () => {
            if (this.audio && !this.audioUnlocked) {
                this.audio.play().then(() => {
                    this.audio.pause();
                    this.audio.currentTime = 0;
                    this.audioUnlocked = true;
                }).catch(() => {});
            }
            document.removeEventListener("click", unlock);
            document.removeEventListener("keydown", unlock);
        };

        document.addEventListener("click", unlock);
        document.addEventListener("keydown", unlock);
    },

    playNotificationSound() {
        if (this.audio) {
            this.audio.currentTime = 0;
            this.audio.play().catch((err) => {
                console.debug("Audio play failed:", err);
            });
        }
    },

    buildDom() {
        this.$root = $(`
            <div class="fchat-root">
                <button class="fchat-bubble" title="Messaging">
                    <svg viewBox="0 0 48 48" class="fchat-bubble-icon" aria-hidden="true">
                        <circle cx="24" cy="24" r="17"></circle>
                        <circle cx="16" cy="19" r="2.5"></circle>
                        <circle cx="30" cy="15" r="2.5"></circle>
                        <circle cx="34" cy="29" r="2.5"></circle>
                        <circle cx="18" cy="31" r="2.5"></circle>
                        <path d="M18.5 19.8L27.5 15.9M18 21L19 28.5M20.5 31L31.5 29.5M31 17L33 26.5"></path>
                    </svg>
                    <span class="fchat-bubble-spark">✦</span>
                    <span class="fchat-badge" style="display:none;">0</span>
                </button>
                <div class="fchat-panel">
                    <div class="fchat-header">
                        <div class="fchat-header-left">
                            <span class="fchat-header-back" style="display:none;"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></span>
                            <span class="fchat-header-avatar" style="display:none;"></span>
                            <div class="fchat-header-title"><span class="fchat-header-name">Messaging</span><span class="fchat-header-status"></span></div>
                        </div>
                        <div class="fchat-header-actions">
                            <button class="fchat-new-group-btn" title="New group"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></button>
                            <button class="fchat-new-btn" title="New message"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
                            <button class="fchat-ask-ai-fab" style="display:none;" title="Ask AI about this conversation"><span class="fchat-ask-ai-fab-icon">✦</span></button>
                            <button class="fchat-close-btn" title="Close"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                        </div>
                    </div>
                    <div class="fchat-search-bar" style="display:none;"><input type="text" class="fchat-search-input" placeholder="Search people..."/></div>
                    <div class="fchat-group-selected-bar" style="display:none;"></div>
                    <div class="fchat-body">
                        <button class="fchat-catchup-banner" style="display:none;"><span class="fchat-catchup-icon">◈</span><span class="fchat-catchup-text">Catch Me Up</span><span class="fchat-catchup-arrow">→</span></button>
                        <button class="fchat-catchup-banner fchat-ai-search-banner" style="display:none;"><span class="fchat-catchup-icon">⌁</span><span class="fchat-catchup-text">Ask AI about your chats</span><span class="fchat-catchup-arrow">→</span></button>
                        <button class="fchat-catchup-banner fchat-erpnext-ai-banner" style="display:none;"><span class="fchat-catchup-icon fchat-erpnext-ai-icon">◇</span><span class="fchat-catchup-text">Ask AI about ERPNext</span><span class="fchat-catchup-arrow">→</span></button>
                        <div class="fchat-list"></div>
                        <div class="fchat-search-results" style="display:none;"></div>
                        <div class="fchat-thread" style="display:none;"><div class="fchat-thread-messages"></div><div class="fchat-typing-indicator" style="display:none;">typing...</div></div>
                        <div class="fchat-group-info" style="display:none;"></div>
                        <div class="fchat-ask-ai-panel" style="display:none;">
                            <div class="fchat-ask-ai-quick-actions" style="display:none;"><button class="fchat-ask-ai-chip fchat-ask-ai-summarize-btn">✦ Summarize this chat</button><button class="fchat-ask-ai-chip fchat-ask-ai-action-items-btn">✓ Find action items</button></div>
                            <div class="fchat-ask-ai-empty"><span class="fchat-ask-ai-empty-icon">✦</span><span class="fchat-ask-ai-empty-text">Ask anything about this conversation.</span></div>
                            <div class="fchat-ask-ai-messages"></div>
                        </div>
                        <div class="fchat-catchup-panel" style="display:none;"><div class="fchat-catchup-loading"><span class="fchat-ai-dots"><span></span><span></span><span></span></span><span>Looking through what you missed...</span></div><div class="fchat-catchup-result" style="display:none;"></div></div>
                        <div class="fchat-drop-hint" style="display:none;"><div class="fchat-drop-hint-inner"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Drop to attach</span></div></div>
                    </div>
                    <div class="fchat-composer" style="display:none;"><div class="fchat-readonly-notice" style="display:none;">This chat is read-only.</div><div class="fchat-attachment-tray" style="display:none;"></div><div class="fchat-composer-inner"><button class="fchat-attach-btn" title="Attach file"><svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg></button><input type="file" class="fchat-attach-input" multiple style="display:none;"/><div class="fchat-ai-assist-wrap"><button class="fchat-ai-assist-btn" title="AI writing assistant" style="display:none;"><span class="fchat-ai-assist-icon">✦</span></button><div class="fchat-ai-assist-menu" style="display:none;"><button class="fchat-ai-assist-item" data-action="draft"><span>✎</span><span>Draft Reply</span></button><button class="fchat-ai-assist-item" data-action="professional"><span>✦</span><span>Make Professional</span></button><button class="fchat-ai-assist-item" data-action="shorter"><span>≡</span><span>Make Shorter</span></button><button class="fchat-ai-assist-item" data-action="friendlier"><span>◡</span><span>Make Friendly</span></button><button class="fchat-ai-assist-item" data-action="translate"><span>◎</span><span>Translate</span></button><div class="fchat-ai-assist-translate-row" style="display:none;"><input type="text" class="fchat-ai-assist-translate-input" placeholder="Language, e.g. Spanish" /><button class="fchat-ai-assist-translate-go">Go</button></div></div></div><textarea class="fchat-composer-input" rows="1" placeholder="Write a message..."></textarea><button class="fchat-send-btn"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4"/></svg></button></div></div>
                    <div class="fchat-ask-ai-footer" style="display:none;"><textarea class="fchat-ask-ai-input" rows="1" placeholder="Ask about this conversation..."></textarea><button class="fchat-ask-ai-send-btn"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4"/></svg></button></div>
                    <div class="fchat-group-setup-footer" style="display:none;"><span class="fchat-group-setup-count">0 selected</span><button class="fchat-group-next-btn" disabled>Next</button></div>
                    <div class="fchat-group-name-bar" style="display:none;"><input type="text" class="fchat-group-name-input" placeholder="Name this group..." maxlength="140" /><button class="fchat-group-create-btn">Create</button></div>
                </div>
            </div>
        `);

        $("body").append(this.$root);
    },

    bindEvents() {
        this.$root.find(".fchat-bubble").on("click", (e) => {
            e.stopPropagation();
            this.togglePanel();
        });

        this.$root.find(".fchat-close-btn").on("click", (e) => {
            e.stopPropagation();
            this.togglePanel(false);
        });

        this.$root.find(".fchat-new-btn").on("click", () => this.showSearch());
        this.$root.find(".fchat-new-group-btn").on("click", () => this.showGroupSetup(true));
        this.$root.find(".fchat-header-back").on("click", () => this.goBack());

        this.$root.find(".fchat-group-next-btn").on("click", () => {
            if (this.state.groupSetupMode === "add") {
                this.addSelectedMembersToGroup();
            } else {
                this.showGroupNameStep();
            }
        });
        this.$root.find(".fchat-group-create-btn").on("click", () => this.createGroupFromSetup());
        this.$root.find(".fchat-group-name-input").on("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.createGroupFromSetup();
            }
        });

        this.$root.find(".fchat-header-title, .fchat-header-avatar").on("click", () => {
            if (this.state.view === "groupThread") this.showGroupInfo();
        });

        $(document).on("click.fchat_outside", (e) => {
            // Close the messaging panel when the user clicks outside the widget.
            if (this.state.open && !$(e.target).closest(".fchat-root").length) {
                this.togglePanel(false);
                return;
            }
            if (!$(e.target).closest(".fchat-member-menu-wrap").length) {
                this.$root.find(".fchat-member-menu").hide();
            }
            if (!$(e.target).closest(".fchat-ai-assist-wrap").length) {
                this.$root.find(".fchat-ai-assist-menu").hide();
                this.$root.find(".fchat-ai-assist-translate-row").hide();
            }
        });

        let searchTimeout;
        this.$root.find(".fchat-search-input").on("input", (e) => {
            clearTimeout(searchTimeout);
            const txt = $(e.target).val();
            searchTimeout = setTimeout(() => {
                if (this.state.view === "newGroup") {
                    this.runGroupMemberSearch(txt);
                } else {
                    this.runSearch(txt);
                }
            }, 200);
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
        this.$root.find(".fchat-composer-input").on("input", (e) =>
this.autoGrowTextarea(e.target));

        // ------------------------------------------------------- Attachments
        this.$root.find(".fchat-attach-btn").on("click", () => {
            this.$root.find(".fchat-attach-input").trigger("click");
        });

        this.$root.find(".fchat-attach-input").on("change", (e) => {
            this.handleFilesSelected(e.target.files);
            e.target.value = "";
        });

        this.$root.find(".fchat-composer-input").on("paste", (e) => {
            const clipboardData = e.originalEvent && e.originalEvent.clipboardData;
            if (!clipboardData || !clipboardData.items) return;

            const files = [];
            for (const item of clipboardData.items) {
                if (item.kind === "file") {
                    const f = item.getAsFile();
                    if (f) files.push(f);
                }
            }
            if (files.length) this.handleFilesSelected(files);
        });

        const $panel = this.$root.find(".fchat-panel");
        let dragCounter = 0;

        const dragAllowed = () => this.state.view === "thread" || this.state.view ===
"groupThread";

        $panel.on("dragenter", (e) => {
            if (!dragAllowed()) return;
            e.preventDefault();
            dragCounter++;
            this.$root.find(".fchat-drop-hint").show();
        });
        $panel.on("dragover", (e) => {
            if (!dragAllowed()) return;
            e.preventDefault();
        });
        $panel.on("dragleave", () => {
            dragCounter = Math.max(0, dragCounter - 1);
            if (dragCounter === 0) this.$root.find(".fchat-drop-hint").hide();
        });
        $panel.on("drop", (e) => {
            dragCounter = 0;
            this.$root.find(".fchat-drop-hint").hide();
            if (!dragAllowed()) return;
            e.preventDefault();
            const dt = e.originalEvent && e.originalEvent.dataTransfer;
            if (dt && dt.files && dt.files.length) this.handleFilesSelected(dt.files);
        });

        this.$root.find(".fchat-thread-messages").on("click", ".fchat-att-grid-item", (e) => {
            const $item = $(e.currentTarget);
            const msgId = $item.attr("data-msg-id");
            const imgIdx = parseInt($item.attr("data-img-idx"), 10) || 0;
            const msg = this.state.messages.find((mm) => mm.name === msgId);
            if (!msg) return;
            const images = (msg.attachments || []).filter((a) => (a.file_type || "").indexOf("image/")
=== 0);
            this.openLightbox(images, imgIdx);
        });

        // ------------------------------------------------------------ Ask AI
        this.$root.find(".fchat-ask-ai-fab").on("click", () => this.openAskAI());
        this.$root.find(".fchat-ask-ai-send-btn").on("click", () => this.askQuestion());
        this.$root.find(".fchat-ask-ai-input").on("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.askQuestion();
            }
        });
        this.$root.find(".fchat-ask-ai-input").on("input", (e) => this.autoGrowTextarea(e.target));
        this.$root.find(".fchat-ask-ai-summarize-btn").on("click", () =>
this.summarizeConversation());
        this.$root.find(".fchat-ask-ai-action-items-btn").on("click", () => this.detectActionItems());
        this.$root.find(".fchat-catchup-banner").not(".fchat-ai-search-banner").on("click", () =>
this.openCatchUp());
        this.$root.find(".fchat-ai-search-banner").on("click", () => this.openChatSearch());
        this.$root.find(".fchat-erpnext-ai-banner").on("click", () => this.openERPNextSearch());

        // ------------------------------------------------- AI Reply Assistant
        this.$root.find(".fchat-ai-assist-btn").on("click", (e) => {
            e.stopPropagation();
            const $menu = this.$root.find(".fchat-ai-assist-menu");
            const isOpen = $menu.is(":visible");
            this.$root.find(".fchat-ai-assist-menu").hide();
            this.$root.find(".fchat-ai-assist-translate-row").hide();
            if (!isOpen) $menu.show();
        });

        this.$root.find(".fchat-ai-assist-menu").on("click", ".fchat-ai-assist-item", (e) => {
            const action = $(e.currentTarget).attr("data-action");
            if (action === "translate") {
                this.$root.find(".fchat-ai-assist-translate-row").toggle();
                this.$root.find(".fchat-ai-assist-translate-input").focus();
                return;
            }
            this.runReplyAssist(action);
        });

        this.$root.find(".fchat-ai-assist-translate-go").on("click", () => {
            const lang = (this.$root.find(".fchat-ai-assist-translate-input").val() || "").trim();
            if (!lang) return;
            this.runReplyAssist("translate", lang);
        });

        this.$root.find(".fchat-ai-assist-translate-input").on("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.$root.find(".fchat-ai-assist-translate-go").trigger("click");
            }
        });
    },

    bindActivityListeners() {
        // Zoho Cliq Presence Logic: Track activity across the whole document
        const handleUserActivity = frappe.utils.debounce(() => {
            if (document.hidden) return;

            if (this.state.userPresence !== 'active') {
                this.state.userPresence = 'active';
                this.heartbeat(); // Immediately inform server of active status
            }

            // Reset idle timer (2 minutes threshold)
            clearTimeout(this.state.idleTimeoutTimer);
            this.state.idleTimeoutTimer = setTimeout(() => {
                this.state.userPresence = 'idle';
                this.heartbeat();
            }, 2 * 60 * 1000);
        }, 300);

        $(window).on("mousemove keydown click scroll", handleUserActivity);

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                this.state.userPresence = 'idle';
                this.heartbeat();
            } else {
                handleUserActivity();
            }
        });

        // Initialize state
        handleUserActivity();
    },

    bindRealtime() {
        if (!frappe.realtime) return;

        frappe.realtime.on("chat:new_message", (data) => this.onNewMessage(data));
        frappe.realtime.on("chat:seen", (data) => this.onSeen(data));
        frappe.realtime.on("chat:typing", (data) => this.onTyping(data));

        frappe.realtime.on("chat:group_new_message", (data) =>
this.onGroupNewMessage(data));
        frappe.realtime.on("chat:group_seen", (data) => this.onGroupSeen(data));
        frappe.realtime.on("chat:group_created", () => this.onGroupRosterChanged());
        frappe.realtime.on("chat:group_updated", (data) =>
this.onGroupRosterChanged(data));
        frappe.realtime.on("chat:group_member_left", (data) =>
this.onGroupRosterChanged(data));
        frappe.realtime.on("chat:group_member_removed", (data) =>
this.onGroupMemberRemoved(data));
        frappe.realtime.on("chat:group_deleted", (data) => this.onGroupDeleted(data));
    },

    togglePanel(force) {
        const s = this.state;
        s.open = force !== undefined ? force : !s.open;

        this.$root.find(".fchat-panel").toggleClass("fchat-panel-open", s.open);
        this.$root.find(".fchat-bubble").toggleClass("fchat-bubble-hidden", s.open);

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
        s.activeUserData = {};
        s.activeGroup = null;
        s.activeGroupData = {};
        s.activeIsGroup = false;
        s.groupSelection.clear();
        s.groupSetupMode = "create";
        this.clearAttachmentTray();

        this.$root.find(".fchat-header-back, .fchat-header-avatar").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn").show();
        this.$root.find(".fchat-header-name").text("Messaging");
        this.$root.find(".fchat-header-status").text("").removeClass("status-active status-idlestatus-offline");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar").hide();
        this.$root.find(".fchat-list").show();
        this.$root.find(".fchat-search-results, .fchat-thread, .fchat-composer,.fchat-group-info").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer, .fchat-catchup-panel").hide();
        this.refreshAIVisibility();

        this.stopPresencePoll();
        this.loadAllConversations();
    },

    goBack() {
        const s = this.state;

        if (s.view === "newGroupName") {
            this.showGroupSetup(false);
        } else if (s.view === "newGroup" && s.groupSetupMode === "add") {
            this.showGroupInfo();
        } else if (s.view === "groupInfo") {
            this.openGroupThread(s.activeGroup, s.activeGroupData);
        } else if (s.view === "askAI") {
            this.returnFromAskAI();
        } else {
            this.showList();
        }
    },

    showSearch() {
        this.state.view = "search";

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-name").text("New message");
        this.$root.find(".fchat-header-status").text("").removeClass("status-active status-idlestatus-offline");
        this.$root.find(".fchat-search-bar").show();
        this.$root.find(".fchat-search-input").val("").focus();
        this.$root.find(".fchat-list, .fchat-thread, .fchat-composer").hide();
        this.$root.find(".fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-search-results").show().empty();

        this.refreshAIVisibility();
        this.runSearch("");
    },

    // -------------------------------------------------------------- Groups

    showGroupSetup(reset) {
        const s = this.state;
        s.view = "newGroup";
        s.groupSetupMode = "create";

        if (reset) {
            s.groupSelection.clear();
        }

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-name").text("Add group members");
        this.$root.find(".fchat-header-status").text("").removeClass("status-active status-idlestatus-offline");
        this.$root.find(".fchat-search-bar").show();
        this.$root.find(".fchat-search-input").val("").focus();
        this.$root.find(".fchat-list, .fchat-thread, .fchat-composer, .fchat-group-name-bar,.fchat-group-info").hide();
        this.$root.find(".fchat-search-results").show();
        this.$root.find(".fchat-group-selected-bar, .fchat-group-setup-footer").show();
        this.$root.find(".fchat-group-next-btn").text("Next");

        this.refreshAIVisibility();
        this.renderGroupSelectedBar();
        this.runGroupMemberSearch("");
    },

    showAddMembers() {
        const s = this.state;
        if (!s.activeGroup) return;

        s.view = "newGroup";
        s.groupSetupMode = "add";
        s.groupSelection.clear();

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-name").text("Add members");
        this.$root.find(".fchat-header-status").text("").removeClass("status-active status-idlestatus-offline");
        this.$root.find(".fchat-search-bar").show();
        this.$root.find(".fchat-search-input").val("").focus();
        this.$root.find(".fchat-list, .fchat-thread, .fchat-composer, .fchat-group-name-bar,.fchat-group-info").hide();
        this.$root.find(".fchat-search-results").show();
        this.$root.find(".fchat-group-selected-bar, .fchat-group-setup-footer").show();
        this.$root.find(".fchat-group-next-btn").text("Add");

        this.refreshAIVisibility();
        this.renderGroupSelectedBar();
        this.runGroupMemberSearch("");
    },

    addSelectedMembersToGroup() {
        const s = this.state;
        if (!s.groupSelection.size || !s.activeGroup) return;

        const $btn = this.$root.find(".fchat-group-next-btn").prop("disabled", true);

        frappe.call({
            method: `${CHAT_API}.add_group_members`,
            args: { group: s.activeGroup, users: Array.from(s.groupSelection.keys()) },
        }).then((r) => {
            $btn.prop("disabled", false);
            s.groupSelection.clear();
            if (r.message) s.activeGroupData = r.message;
            this.showGroupInfo();
        }).catch(() => {
            $btn.prop("disabled", false);
        });
    },

    runGroupMemberSearch(txt) {
        const args = { txt: (txt || "").trim() };
        if (this.state.groupSetupMode === "add" && this.state.activeGroup) {
            args.exclude_group = this.state.activeGroup;
        }

        frappe.call({
            method: `${CHAT_API}.search_users`,
            args,
        }).then((r) => {
            const $res = this.$root.find(".fchat-search-results").empty();
            const users = r.message || [];

            users.forEach((u) => {
                const user = u.user;
                const fullName = u.full_name || user;
                const selected = this.state.groupSelection.has(user);

                const $row = $(`<div class="fchat-row fchat-row-selectable ${selected ? "fchat-row-selected" :""}"><span class="fchat-checkbox">${selected ? "✓" : ""}</span><span class="fchat-avatar-wrap">${this.avatarHtml(fullName, u.image, user,u.is_bot)}</span><div class="fchat-row-body"><div class="fchat-row-top"><span class="fchat-row-name">${frappe.utils.escape_html(fullName)}</span></div><div class="fchat-row-preview">${frappe.utils.escape_html(user)}</div></div></div>`);

                $row.on("click", () => this.toggleGroupMember(user, fullName, u.image, u.is_bot,
$row));
                $res.append($row);
            });

            if (!users.length) {
                $res.append(`<div class="fchat-empty">No users found</div>`);
            }
        });
    },

    toggleGroupMember(user, fullName, image, isBot, $row) {
        const s = this.state;

        if (s.groupSelection.has(user)) {
            s.groupSelection.delete(user);
            $row.removeClass("fchat-row-selected");
            $row.find(".fchat-checkbox").text("");
        } else {
            s.groupSelection.set(user, { full_name: fullName, image, is_bot: isBot });
            $row.addClass("fchat-row-selected");
            $row.find(".fchat-checkbox").text("✓");
        }

        this.renderGroupSelectedBar();
    },

    renderGroupSelectedBar() {
        const s = this.state;
        const $bar = this.$root.find(".fchat-group-selected-bar").empty();
        const $count = this.$root.find(".fchat-group-setup-count");
        const $next = this.$root.find(".fchat-group-next-btn");

        if (!s.groupSelection.size) {
            $bar.hide();
        } else {
            $bar.show();
            s.groupSelection.forEach((data, user) => {
                const $chip = $(`<span class="fchat-group-chip">${frappe.utils.escape_html(data.full_name || user)}<span class="fchat-group-chip-remove">&times;</span></span>`);
                $chip.find(".fchat-group-chip-remove").on("click", () => {
                    s.groupSelection.delete(user);
                    this.renderGroupSelectedBar();
                    this.runGroupMemberSearch(this.$root.find(".fchat-search-input").val());
                });
                $bar.append($chip);
            });
        }

        $count.text(`${s.groupSelection.size} selected`);
        $next.prop("disabled", s.groupSelection.size === 0);
    },

    showGroupNameStep() {
        const s = this.state;
        if (!s.groupSelection.size) return;

        s.view = "newGroupName";

        this.$root.find(".fchat-header-name").text("Name your group");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar,.fchat-group-setup-footer").hide();
        this.$root.find(".fchat-search-results, .fchat-list, .fchat-thread, .fchat-composer").hide();
        this.$root.find(".fchat-group-name-bar").show();
        this.$root.find(".fchat-group-name-input").val("").focus();

        this.refreshAIVisibility();
    },

    createGroupFromSetup() {
        const s = this.state;
        const groupName = (this.$root.find(".fchat-group-name-input").val() || "").trim();

        if (!groupName || !s.groupSelection.size) return;

        const $btn = this.$root.find(".fchat-group-create-btn").prop("disabled", true);

        frappe.call({
            method: `${CHAT_API}.create_group`,
            args: {
                group_name: groupName,
                users: Array.from(s.groupSelection.keys()),
            },
        }).then((r) => {
            $btn.prop("disabled", false);
            if (r.message) {
                s.groupSelection.clear();
                this.openGroupThread(r.message.group, r.message);
            }
        }).catch(() => {
            $btn.prop("disabled", false);
        });
    },

    openThread(user, fullName, image, isBot, enabled) {
        const s = this.state;
        s.view = "thread";
        s.activeUser = user;
        this.clearAttachmentTray();
        s.askAiMessages = [];

        const isReadOnly = isBot || user === NOTIFICATION_BOT_USER || enabled === 0;

        s.activeGroup = null;
        s.activeGroupData = {};
        s.activeIsGroup = false;

        s.activeUserData = {
            user,
            fullName: fullName || user,
            image,
            isBot: isBot || user === NOTIFICATION_BOT_USER,
            enabled: enabled !== undefined ? enabled : 1,
            isReadOnly: isReadOnly,
        };

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer").hide();

this.$root.find(".fchat-header-avatar").show().html(this.avatarHtml(s.activeUserData.fullName
, image, user, s.activeUserData.isBot));
        this.$root.find(".fchat-header-name").text(s.activeUserData.fullName);
        this.$root.find(".fchat-search-bar").hide();
        this.$root.find(".fchat-list, .fchat-search-results").hide();
        this.$root.find(".fchat-thread, .fchat-composer").show();

        this.applyReadOnlyState(isReadOnly);

        if (!isReadOnly) {
            this.$root.find(".fchat-composer-input").val("").focus();
        this.resetComposerHeight(".fchat-composer-input");
        }

        this.loadMessages(user);
        this.refreshAIVisibility();

        if (!s.activeUserData.isBot) {
            this.startPresencePoll([user]);
        } else {
            this.stopPresencePoll();
            this.$root.find(".fchat-header-status")
                .text("System Bot")
                .removeClass("status-active status-idle status-offline");
        }
    },

    openGroupThread(group, groupData) {
        const s = this.state;
        s.view = "groupThread";
        s.activeUser = null;
        s.activeUserData = {};
        s.activeGroup = group;
        s.activeIsGroup = true;
        s.activeGroupData = groupData || {};
        this.clearAttachmentTray();
        s.askAiMessages = [];

        this.stopPresencePoll();

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").addClass("fchat-header-clickable");
        this.$root.find(".fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer").hide();

this.$root.find(".fchat-header-avatar").show().html(this.groupAvatarHtml(s.activeGroupData));
        this.$root.find(".fchat-header-name").text(s.activeGroupData.group_name || "Group");
        this.$root.find(".fchat-header-status")
            .text(`${s.activeGroupData.member_count || ""} members`.trim())
            .removeClass("status-active status-idle status-offline");
        this.$root.find(".fchat-search-bar").hide();
        this.$root.find(".fchat-list, .fchat-search-results").hide();
        this.$root.find(".fchat-thread, .fchat-composer").show();

        this.applyReadOnlyState(false);
        this.$root.find(".fchat-composer-input").val("").focus();
        this.resetComposerHeight(".fchat-composer-input");

        this.loadGroupMessages(group);
        this.refreshAIVisibility();
    },

    loadGroupMessages(group) {
        frappe.call({
            method: `${CHAT_API}.get_group_messages`,
            args: { group },
        }).then((r) => {
            this.state.messages = r.message || [];
            this.renderThread();
            this.refreshUnread();
        });
    },

    onGroupNewMessage(data) {
        const s = this.state;
        const me = frappe.session.user;

        if (!data || data.from_user === me) return;

        this.playNotificationSound();

        if (s.open && s.view === "groupThread" && s.activeGroup === data.group) {
            s.messages.push(data);
            this.renderThread();
            frappe.call({ method: `${CHAT_API}.group_mark_seen`, args: { group: data.group }
});
        } else {
            this.showGroupToast(data);
            this.bumpBadge();
        }

        if (s.open && s.view === "list") {
            this.patchGroupPreview(data.group, data, true);
        }
    },

    onGroupSeen(data) {
        // Group reads aren't reflected per-message in this UI (no per-recipient tick tracking), // but keep the hook for future read-receipt display.
    },

    onGroupRosterChanged(data) {
        const s = this.state;

        if (s.open && s.view === "list") {
            this.loadAllConversations();
        }

        if (data && s.activeGroup && s.activeGroup === data.group) {
            frappe.call({
                method: `${CHAT_API}.get_group_details`,
                args: { group: s.activeGroup },
            }).then((r) => {
                if (r.message) {
                    s.activeGroupData = r.message;
                    this.$root.find(".fchat-header-status")
                        .text(`${r.message.member_count || ""} members`.trim());
                    this.$root.find(".fchat-header-name").text(r.message.group_name || "Group");
                    if (s.view === "groupThread" || s.view === "groupInfo") {
                        this.$root.find(".fchat-header-avatar").html(this.groupAvatarHtml(r.message));
                    }
                    if (s.view === "groupInfo") {
                        this.renderGroupInfo(r.message);
                    }
                }
            });
        }
    },

    showGroupToast(data) {
        const name = data.from_full_name || data.from_user || "";
        const groupName = data.group_name || "Group";

        const $toast = $(`<div class="fchat-toast"><div class="fchat-toast-title">${frappe.utils.escape_html(groupName)}</div><div class="fchat-toast-msg"><strong>${frappe.utils.escape_html(name)}:</strong>${frappe.utils.escape_html((data.message || "").slice(0, 70))}</div></div>`);

        $toast.on("click", (e) => {
            e.stopPropagation();
            this.togglePanel(true);
            frappe.call({
                method: `${CHAT_API}.get_group_details`,
                args: { group: data.group },
            }).then((r) => {
                if (r.message) this.openGroupThread(data.group, r.message);
            });
            $toast.remove();
        });

        $("body").append($toast);

        requestAnimationFrame(() => $toast.addClass("fchat-toast-in"));

        setTimeout(() => {
            $toast.removeClass("fchat-toast-in");
            setTimeout(() => $toast.remove(), 300);
        }, 5000);
    },

    // --------------------------------------------------------- Group Info

    showGroupInfo() {
        const s = this.state;
        if (!s.activeGroup) return;

        s.view = "groupInfo";

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-name").text("Group info");
        this.$root.find(".fchat-header-status").text("").removeClass("status-active status-idlestatus-offline");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar").hide();
        this.$root.find(".fchat-list, .fchat-search-results, .fchat-thread, .fchat-composer").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer").hide();
        this.$root.find(".fchat-group-info").show();

        this.refreshAIVisibility();
        this.loadGroupInfo();
    },

    loadGroupInfo() {
        const s = this.state;
        frappe.call({
            method: `${CHAT_API}.get_group_details`,
            args: { group: s.activeGroup },
        }).then((r) => {
            if (r.message) {
                s.activeGroupData = r.message;
                this.renderGroupInfo(r.message);
            }
        });
    },

    renderGroupInfo(data) {
        const me = frappe.session.user;
        const amIAdmin = !!data.is_admin;

        const $panel = this.$root.find(".fchat-group-info").empty();

        const $header = $(`<div class="fchat-group-info-header"><span class="fchat-group-info-avatar-wrap"><span class="fchat-group-info-avatar">${this.groupAvatarHtml(data)}</span></span><span class="fchat-group-info-name-row"><span class="fchat-group-info-name">${frappe.utils.escape_html(data.group_name)}</span></span><span class="fchat-group-info-meta">${data.member_count} members</span></div>`);

        if (amIAdmin) {
            const $avatarWrap = $header.find(".fchat-group-info-avatar-wrap");
            const $camBtn = $(`<button class="fchat-group-photo-edit-btn" title="Change photo"><svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 01-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>`);
            const $fileInput = $(`<input type="file" accept="image/*"class="fchat-group-photo-input" style="display:none;" />`);

            $camBtn.on("click", () => $fileInput.trigger("click"));
            $fileInput.on("change", (e) => {
                const file = e.target.files && e.target.files[0];
                if (file) this.uploadGroupPhoto(file);
                $fileInput.val("");
            });

            $avatarWrap.append($camBtn, $fileInput);

            if (data.group_image) {
                const $removePhoto = $(`<button class="fchat-group-photo-remove-btn">Removephoto</button>`);
                $removePhoto.on("click", () => this.removeGroupPhoto());
                $header.find(".fchat-group-info-avatar-wrap").after($removePhoto);
            }

            const $editBtn = $(`<button class="fchat-group-name-edit-btn" title="Edit group name"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.122.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>`);
            $editBtn.on("click", () => this.startEditGroupName());
            $header.find(".fchat-group-info-name-row").append($editBtn);
        }

        $panel.append($header);

        const $addRow = $(`<div class="fchat-group-add-participants-row"><span class="fchat-group-add-icon"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span><span class="fchat-group-add-label">Add participants</span></div>`);
        $addRow.on("click", () => this.showAddMembers());
        $panel.append($addRow);

        const $members = $(`<div class="fchat-group-info-members"></div>`);

        (data.members || []).forEach((m) => {
            const isMe = m.user === me;
            const $row = $(`<div class="fchat-group-member-row"><span class="fchat-avatar-wrap">${this.avatarHtml(m.full_name, m.image,m.user, m.is_bot)}</span><div class="fchat-row-body"><div class="fchat-row-top"><span class="fchat-row-name">${frappe.utils.escape_html(m.full_name)}${isMe ? " (You)" :""}</span></div>${m.is_admin ? `<span class="fchat-admin-tag">Admin</span>` : ""}</div></div>`);

            if (amIAdmin && !isMe) {
                const $menuWrap = $(`<div class="fchat-member-menu-wrap"></div>`);
                const $kebabBtn = $(`<button class="fchat-member-kebab-btn" title="Member options"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12"cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>`);
                const $menu = $(`<div class="fchat-member-menu" style="display:none;"></div>`);

                const $adminItem = $(`<button class="fchat-member-menu-item">${m.is_admin ?"Dismiss as admin" : "Make admin"}</button>`);
                $adminItem.on("click", (e) => {
                    e.stopPropagation();
                    $menu.hide();
                    this.toggleMemberAdmin(m.user, !m.is_admin);
                });

                const $removeItem = $(`<button class="fchat-member-menu-itemfchat-member-menu-item-danger">Remove</button>`);
                $removeItem.on("click", (e) => {
                    e.stopPropagation();
                    $menu.hide();
                    this.removeMember(m.user, m.full_name);
                });

                $menu.append($adminItem, $removeItem);

                $kebabBtn.on("click", (e) => {
                    e.stopPropagation();
                    const isOpen = $menu.is(":visible");
                    this.$root.find(".fchat-member-menu").hide();
                    if (!isOpen) $menu.show();
                });

                $menuWrap.append($kebabBtn, $menu);
                $row.append($menuWrap);
            }

            $members.append($row);
        });

        $panel.append($members);

        const $actionsBar = $(`<div class="fchat-group-info-actions"><button class="fchat-group-exit-btn">Exit group</button>${amIAdmin ? `<button class="fchat-group-delete-btn">Delete group</button>` :""}</div>`);

        $actionsBar.find(".fchat-group-exit-btn").on("click", () => this.exitGroup());
        $actionsBar.find(".fchat-group-delete-btn").on("click", () => this.deleteGroupConfirm());

        $panel.append($actionsBar);
    },

    startEditGroupName() {
        const s = this.state;
        const $nameRow = this.$root.find(".fchat-group-info-name-row");
        const currentName = s.activeGroupData.group_name || "";

        $nameRow.empty();

        const $input = $(`<input type="text" class="fchat-group-name-edit-input"maxlength="140" />`).val(currentName);
        const $saveBtn = $(`<button class="fchat-group-name-save-btn">Save</button>`);
        const $cancelBtn = $(`<buttonclass="fchat-group-name-cancel-btn">Cancel</button>`);

        const save = () => {
            const newName = ($input.val() || "").trim();
            if (!newName || newName === currentName) {
                this.renderGroupInfo(s.activeGroupData);
                return;
            }

            $saveBtn.prop("disabled", true);
            frappe.call({
                method: `${CHAT_API}.rename_group`,
                args: { group: s.activeGroup, group_name: newName },
            }).then((r) => {
                if (r.message) {
                    s.activeGroupData = r.message;
                    this.renderGroupInfo(r.message);
                    this.$root.find(".fchat-header-name").text(r.message.group_name);
                }
            }).catch(() => {
                $saveBtn.prop("disabled", false);
            });
        };

        $saveBtn.on("click", save);
        $cancelBtn.on("click", () => this.renderGroupInfo(s.activeGroupData));
        $input.on("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); save(); }
            if (e.key === "Escape") { e.preventDefault();
this.renderGroupInfo(s.activeGroupData); }
        });

        $nameRow.append($input, $saveBtn, $cancelBtn);
        $input.focus().select();
    },

    uploadGroupPhoto(file) {
        const s = this.state;
        const formData = new FormData();
        formData.append("file", file);
        formData.append("doctype", "Chat Group");
        formData.append("docname", s.activeGroup);
        formData.append("fieldname", "group_image");
        formData.append("is_private", 0);

        $.ajax({
            url: "/api/method/upload_file",
            type: "POST",
            data: formData,
            processData: false,
            contentType: false,
            headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
        }).then((r) => {
            const fileUrl = r.message && r.message.file_url;
            if (!fileUrl) return;

            frappe.call({
                method: `${CHAT_API}.set_group_photo`,
                args: { group: s.activeGroup, image: fileUrl },
            }).then((res) => {
                if (res.message) {
                    s.activeGroupData = res.message;
                    this.renderGroupInfo(res.message);
                    this.$root.find(".fchat-header-avatar").html(this.groupAvatarHtml(res.message));
                }
            });
        }).catch(() => {
            frappe.show_alert && frappe.show_alert({ message: __("Could not upload photo"),
indicator: "red" });
        });
    },

    removeGroupPhoto() {
        const s = this.state;
        frappe.call({
            method: `${CHAT_API}.remove_group_photo`,
            args: { group: s.activeGroup },
        }).then((r) => {
            if (r.message) {
                s.activeGroupData = r.message;
                this.renderGroupInfo(r.message);
                this.$root.find(".fchat-header-avatar").html(this.groupAvatarHtml(r.message));
            }
        });
    },

    toggleMemberAdmin(user, makeAdmin) {
        const s = this.state;
        const method = makeAdmin ? "make_group_admin" : "dismiss_group_admin";

        frappe.call({
            method: `${CHAT_API}.${method}`,
            args: { group: s.activeGroup, user },
        }).then((r) => {
            if (r.message) {
                s.activeGroupData = r.message;
                this.renderGroupInfo(r.message);
            }
        }).catch(() => {});
    },

    removeMember(user, fullName) {
        const s = this.state;

        frappe.confirm(
            __("Remove {0} from this group?", [frappe.utils.escape_html(fullName)]),
            () => {
                frappe.call({
                    method: `${CHAT_API}.remove_group_member`,
                    args: { group: s.activeGroup, user },
                }).then((r) => {
                    if (r.message) {
                        s.activeGroupData = r.message;
                        this.renderGroupInfo(r.message);
                    }
                });
            }
        );
    },

    exitGroup() {
        const s = this.state;

        frappe.confirm(
            __("Are you sure you want to exit this group?"),
            () => {
                frappe.call({
                    method: `${CHAT_API}.leave_group`,
                    args: { group: s.activeGroup },
                }).then(() => {
                    this.showList();
                });
            }
        );
    },

    deleteGroupConfirm() {
        const s = this.state;

        frappe.confirm(
            __("Delete this group for everyone? This cannot be undone."),
            () => {
                frappe.call({
                    method: `${CHAT_API}.delete_group`,
                    args: { group: s.activeGroup },
                }).then(() => {
                    this.showList();
                });
            }
        );
    },

    onGroupMemberRemoved(data) {
        // This event is only ever pushed to the removed user themselves.
        const s = this.state;
        if (!data) return;

        if (s.activeGroup === data.group) {
            this.showList();
        } else if (s.open && s.view === "list") {
            this.loadAllConversations();
        }

        this.showSystemToast("You were removed from a group.");
    },

    onGroupDeleted(data) {
        const s = this.state;
        if (!data) return;

        if (s.activeGroup === data.group) {
            this.showList();
            this.showSystemToast("This group was deleted.");
        } else if (s.open && s.view === "list") {
            this.loadAllConversations();
        }
    },

    showSystemToast(text) {
        const $toast = $(`<div class="fchat-toast"><div class="fchat-toast-title">Messaging</div><div class="fchat-toast-msg">${frappe.utils.escape_html(text)}</div></div>`);

        $("body").append($toast);
        requestAnimationFrame(() => $toast.addClass("fchat-toast-in"));
        setTimeout(() => {
            $toast.removeClass("fchat-toast-in");
            setTimeout(() => $toast.remove(), 300);
        }, 4000);
    },

    // ------------------------------------------------------------- Ask AI

    refreshAIVisibility() {
        const s = this.state;
        const inThread = s.view === "thread" || s.view === "groupThread";
        const readOnly = !s.activeIsGroup && s.activeUserData &&
s.activeUserData.isReadOnly;
        const showFab = inThread && !readOnly && !!s.aiFeatures.ask_this_chat;

        this.$root.find(".fchat-ask-ai-fab").toggle(!!showFab);

        const showCatchup = s.view === "list" && !!s.aiFeatures.catch_me_up;

this.$root.find(".fchat-catchup-banner").not(".fchat-ai-search-banner").toggle(!!showCatchup);

        const showChatSearch = s.view === "list" && !!s.aiFeatures.chat_search;
        this.$root.find(".fchat-ai-search-banner").toggle(!!showChatSearch);

        const showERPNextSearch = s.view === "list" && !!s.aiFeatures.erpnext_search;
        this.$root.find(".fchat-erpnext-ai-banner").toggle(!!showERPNextSearch);

        const showAssist = inThread && !readOnly && !!s.aiFeatures.reply_assistant;
        this.$root.find(".fchat-ai-assist-btn").toggle(!!showAssist);
    },

    openAskAI() {
        const s = this.state;
        if (!s.activeUser && !s.activeGroup) return;

        s.askAiMode = "thread";
        s.askAiReturnView = s.view; // 'thread' or 'groupThread'
        s.view = "askAI";

        const title = s.askAiReturnView === "groupThread"
            ? (s.activeGroupData.group_name || "Group")
            : (s.activeUserData.fullName || s.activeUser);

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-header-name").text("Ask AI");
        this.$root.find(".fchat-header-status")
            .text(title)
            .removeClass("status-active status-idle status-offline");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-list, .fchat-search-results, .fchat-thread, .fchat-composer,.fchat-catchup-panel").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer").show();

this.$root.find(".fchat-ask-ai-summarize-btn").toggle(!!s.aiFeatures.conversation_summary);
        this.$root.find(".fchat-ask-ai-action-items-btn").toggle(!!s.aiFeatures.action_items);

this.$root.find(".fchat-ask-ai-quick-actions").toggle(!!s.aiFeatures.conversation_summary ||
!!s.aiFeatures.action_items);
        this.$root.find(".fchat-ask-ai-input").attr("placeholder", "Ask about this conversation...");

        this.refreshAIVisibility();
        this.renderAskAiMessages();
        this.$root.find(".fchat-ask-ai-input").val("").focus();
        this.resetComposerHeight(".fchat-ask-ai-input");
    },

    openChatSearch() {
        const s = this.state;

        s.askAiMode = "global";
        s.askAiReturnView = "list";
        s.view = "askAI";

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-header-name").text("Ask AI");
        this.$root.find(".fchat-header-status")
            .text("Across all your chats")
            .removeClass("status-active status-idle status-offline");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-list, .fchat-search-results, .fchat-thread, .fchat-composer,.fchat-catchup-panel").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer").show();
        this.$root.find(".fchat-ask-ai-quick-actions").hide(); // no per-thread actions in global mode
        this.$root.find(".fchat-ask-ai-input").attr("placeholder", "Ask about any of your chats...");

        this.refreshAIVisibility();
        this.renderAskAiMessages();
        this.$root.find(".fchat-ask-ai-input").val("").focus();
        this.resetComposerHeight(".fchat-ask-ai-input");
    },

    openERPNextSearch() {
        const s = this.state;

        s.askAiMode = "erpnext";
        s.askAiReturnView = "list";
        s.view = "askAI";

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-header-name").text("Ask AI");
        this.$root.find(".fchat-header-status")
            .text("Across ERPNext")
            .removeClass("status-active status-idle status-offline");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-list, .fchat-search-results, .fchat-thread, .fchat-composer,.fchat-catchup-panel").hide();
        this.$root.find(".fchat-ask-ai-panel, .fchat-ask-ai-footer").show();
        this.$root.find(".fchat-ask-ai-quick-actions").hide();
        this.$root.find(".fchat-ask-ai-input").attr("placeholder", "Ask anything about ERPNext...");

        this.refreshAIVisibility();
        this.renderAskAiMessages();
        this.$root.find(".fchat-ask-ai-input").val("").focus();
        this.resetComposerHeight(".fchat-ask-ai-input");
    },

    returnFromAskAI() {
        const s = this.state;

        if (s.askAiReturnView === "groupThread" && s.activeGroup) {
            this.openGroupThread(s.activeGroup, s.activeGroupData);
        } else if (s.askAiReturnView === "thread" && s.activeUser) {
            const u = s.activeUserData;
            this.openThread(s.activeUser, u.fullName, u.image, u.isBot, u.enabled);
        } else {
            this.showList();
        }
    },

    askQuestion() {
        const s = this.state;
        const $input = this.$root.find(".fchat-ask-ai-input");
        const question = ($input.val() || "").trim();

        if (!question) return;

        $input.val("");
        $input[0].style.height = "";
        $input[0].style.overflowY = "hidden";

        const isGlobal = s.askAiMode === "global";
        const entry = { type: "qa", question, answer: null, loading: true, error: false, sources: [] };
        const targetArray = isGlobal ? s.chatSearchMessages : s.askAiMessages;
        targetArray.push(entry);
        this.renderAskAiMessages();

        if (isGlobal) {
            frappe.call({
                method: `${CHAT_API_AI_FEATURES}.ask_across_chats`,
                args: { question },
            }).then((r) => {
                entry.loading = false;
                entry.answer = (r.message && r.message.answer) || "No answer returned.";
                entry.sources = (r.message && r.message.sources) || [];
                this.renderAskAiMessages();
            }).catch(() => {
                entry.loading = false;
                entry.error = true;
                entry.answer = "Something went wrong answering that. Please try again.";
                this.renderAskAiMessages();
            });
            return;
        }

        if (isERPNext) {
         frappe.call({
             method: `${CHAT_API_AI_FEATURES}.ask_erpnext`,
             args: { question },
         }).then((r) => {
             entry.loading = false;
             entry.answer = (r.message && r.message.answer) || "No answer returned.";
             entry.sources = (r.message && r.message.sources) || [];
             this.renderAskAiMessages();
         }).catch(() => {
             entry.loading = false;
             entry.error = true;
             entry.answer = "Something went wrong searching ERPNext. Please try again.";
             this.renderAskAiMessages();
         });
         return;
     }

     const args = { question };
        if (s.askAiReturnView === "groupThread") {
            args.group = s.activeGroup;
        } else {
            args.user = s.activeUser;
        }

        frappe.call({
            method: `${CHAT_API_AI_FEATURES}.ask_this_chat`,
            args,
        }).then((r) => {
            entry.loading = false;
            entry.answer = (r.message && r.message.answer) || "No answer returned.";
            this.renderAskAiMessages();
        }).catch(() => {
            entry.loading = false;
            entry.error = true;
            entry.answer = "Something went wrong answering that. Please try again.";
            this.renderAskAiMessages();
        });
    },

    summarizeConversation() {
        const s = this.state;

        const entry = { type: "summary", loading: true, error: false, data: null };
        s.askAiMessages.push(entry);
        this.renderAskAiMessages();

        const args = {};
        if (s.askAiReturnView === "groupThread") {
            args.group = s.activeGroup;
        } else {
            args.user = s.activeUser;
        }

        frappe.call({
            method: `${CHAT_API_AI_FEATURES}.conversation_summary`,
            args,
        }).then((r) => {
            entry.loading = false;
            entry.data = r.message || {};
            this.renderAskAiMessages();
        }).catch(() => {
            entry.loading = false;
            entry.error = true;
            this.renderAskAiMessages();
        });
    },

    detectActionItems() {
        const s = this.state;

        const entry = { type: "action_items", loading: true, error: false, data: null, created: null };
        s.askAiMessages.push(entry);
        this.renderAskAiMessages();

        const args = {};
        if (s.askAiReturnView === "groupThread") {
            args.group = s.activeGroup;
        } else {
            args.user = s.activeUser;
        }

        frappe.call({
            method: `${CHAT_API_AI_FEATURES}.detect_action_items`,
            args,
        }).then((r) => {
            entry.loading = false;
            const data = r.message || { items: [] };
            data.items = (data.items || []).map((item) => ({ ...item, selected: true }));
            entry.data = data;
            this.renderAskAiMessages();
        }).catch(() => {
            entry.loading = false;
            entry.error = true;
            this.renderAskAiMessages();
        });
    },

    createTasksFromActionItems(entry) {
        const selected = (entry.data.items || []).filter((i) => i.selected);
        if (!selected.length) return;

        const $btn = this.$root.find(".fchat-ai-action-items-create-btn")
            .prop("disabled", true)
            .text("Creating...");

        frappe.call({
            method: `${CHAT_API_AI_FEATURES}.create_tasks_from_action_items`,
            args: { items: selected },
        }).then((r) => {
            entry.created = (r.message && r.message.created) || [];
            this.renderAskAiMessages();
        }).catch(() => {
            $btn.prop("disabled", false).text(`Create Tasks (${selected.length})`);
            this.showSystemToast("Couldn't create tasks. Please try again.");
        });
    },

    renderAskAiMessages() {
        const s = this.state;
        const isGlobal = s.askAiMode === "global";
        const isERPNext = s.askAiMode === "erpnext";
        const messages = isGlobal ? s.chatSearchMessages : (isERPNext ? s.erpnextAiMessages : s.askAiMessages);

        const $wrap = this.$root.find(".fchat-ask-ai-messages").empty();
        const $empty = this.$root.find(".fchat-ask-ai-empty");

        if (!messages.length) {
            this.$root.find(".fchat-ask-ai-empty-text").text(
                isGlobal ? "Ask anything about your chats." : (isERPNext ? "Ask anything about your ERPNext data." : "Ask anything about this conversation.")
            );
            $empty.show();
            return;
        }
        $empty.hide();

        messages.forEach((entry) => {
            if (entry.type === "summary") {
                $wrap.append(this.buildSummaryCardHtml(entry));
                return;
            }

            if (entry.type === "action_items") {
                $wrap.append(this.buildActionItemsCard(entry));
                return;
            }

            const answerHtml = entry.loading
                ? `<span class="fchat-ai-dots"><span></span><span></span><span></span></span>`
                : frappe.utils.escape_html(entry.answer || "");

            const sourcesHtml = (!entry.loading && entry.sources && entry.sources.length)
                ? `<div class="fchat-ai-answer-sources">Sources: ${entry.sources.map((src) =>frappe.utils.escape_html(src.label)).join(", ")}</div>`
                : "";

            $wrap.append(`<div class="fchat-ai-qa"><div class="fchat-ai-question">${frappe.utils.escape_html(entry.question)}</div><div class="fchat-ai-answer ${entry.loading ? "fchat-ai-answer-loading" : ""}${entry.error ? "fchat-ai-answer-error" : ""}"><span class="fchat-ai-sparkle">✨</span><div class="fchat-ai-answer-body"><span class="fchat-ai-answer-text">${answerHtml}</span>${sourcesHtml}</div></div></div>`);
        });

        if ($wrap[0]) $wrap.scrollTop($wrap[0].scrollHeight);
    },

    buildActionItemsCard(entry) {
        if (entry.loading) {
            return $(`<div class="fchat-ai-summary-card fchat-ai-summary-loading"><div class="fchat-ai-summary-header">✨ Finding action items…</div><span class="fchat-ai-dots"><span></span><span></span><span></span></span></div>`);
        }

        if (entry.error || !entry.data) {
            return $(`<div class="fchat-ai-summary-card fchat-ai-summary-error"><div class="fchat-ai-summary-header">✨ Action Items</div><div class="fchat-ai-summary-empty">Couldn't detect action items. Please try again.</div></div>`);
        }

        const items = entry.data.items || [];
        const $card = $(`<div class="fchat-ai-summary-card fchat-ai-action-items-card"></div>`);
        $card.append(`<div class="fchat-ai-summary-header">✨ Action Items</div>`);

        if (!items.length) {
            $card.append(`<div class="fchat-ai-summary-empty">No action items found in this conversation.</div>`);
            return $card;
        }

        if (entry.created) {
            const n = entry.created.length;
            $card.append(`<div class="fchat-ai-action-created">✅ ${n} task${n === 1 ? "" : "s"} created</div>`);
            return $card;
        }

        const $list = $(`<div class="fchat-ai-action-item-list"></div>`);

        items.forEach((item) => {
            const metaParts = [];
            if (item.assignee) metaParts.push(frappe.utils.escape_html(item.assignee));
            if (item.due) metaParts.push(`Due ${frappe.utils.escape_html(item.due)}`);

            const $row = $(`<div class="fchat-ai-action-item-row ${item.selected ?"fchat-ai-action-item-selected" : ""}"><span class="fchat-checkbox">${item.selected ? "✓" : ""}</span><div class="fchat-ai-action-item-body"><div class="fchat-ai-action-item-task">${frappe.utils.escape_html(item.task)}</div>${metaParts.length ? `<div
class="fchat-ai-action-item-meta">${metaParts.join(" · ")}</div>` : ""}</div></div>`);

            $row.on("click", () => {
                item.selected = !item.selected;
                this.renderAskAiMessages();
            });

            $list.append($row);
        });

        $card.append($list);

        const selectedCount = items.filter((i) => i.selected).length;
        const $createBtn = $(`<button class="fchat-ai-action-items-create-btn" ${selectedCount ? "" : "disabled"}>Create Task${selectedCount === 1 ? "" : "s"} (${selectedCount})</button>`);
        $createBtn.on("click", () => this.createTasksFromActionItems(entry));
        $card.append($createBtn);

        return $card;
    },

    buildSummaryCardHtml(entry) {
        if (entry.loading) {
            return `<div class="fchat-ai-summary-card fchat-ai-summary-loading"><div class="fchat-ai-summary-header">✨ Summarizing this conversation…</div><span class="fchat-ai-dots"><span></span><span></span><span></span></span></div>`;
        }

        if (entry.error || !entry.data) {
            return `<div class="fchat-ai-summary-card fchat-ai-summary-error"><div class="fchat-ai-summary-header">✨ Conversation Summary</div><div class="fchat-ai-summary-empty">Couldn't generate a summary. Please try again.</div></div>`;
        }

        const data = entry.data;

        if (!data.message_count) {
            return `<div class="fchat-ai-summary-card"><div class="fchat-ai-summary-header">✨ Conversation Summary</div><div class="fchat-ai-summary-empty">No messages yet to summarize.</div></div>`;
        }

        let sections = "";

        if (data.topic) {
            sections += `<div class="fchat-ai-summary-topic">${frappe.utils.escape_html(data.topic)}</div>`;
        }

        sections += this.buildSummarySection("Decisions", data.decisions, (d) =>
frappe.utils.escape_html(d));
        sections += this.buildSummarySection(
            "Action Items",
            data.action_items,
            (item) => `<strong>${frappe.utils.escape_html(item.assignee ||"Someone")}</strong> → ${frappe.utils.escape_html(item.task || "")}`
        );
        sections += this.buildSummarySection("Pending", data.pending, (p) =>
frappe.utils.escape_html(p));

        if (!sections) {
            sections = `<div class="fchat-ai-summary-empty">Nothing notable to reportyet.</div>`;
        }

        return `<div class="fchat-ai-summary-card"><div class="fchat-ai-summary-header">✨ Conversation Summary</div>${sections}</div>`;
    },

    buildSummarySection(label, items, renderItem) {
        if (!items || !items.length) return "";

        const rows = items.map((item) => `<li>${renderItem(item)}</li>`).join("");
        return `<div class="fchat-ai-summary-section"><div class="fchat-ai-summary-label">${frappe.utils.escape_html(label)}</div><ul>${rows}</ul></div>`;
    },

    // ---------------------------------------------------------- Catch Me Up

    openCatchUp() {
        const s = this.state;
        s.view = "catchUp";

        this.$root.find(".fchat-header-back").show();
        this.$root.find(".fchat-new-group-btn, .fchat-new-btn, .fchat-ask-ai-fab").hide();
        this.$root.find(".fchat-header-avatar").hide();
        this.$root.find(".fchat-header-title,.fchat-header-avatar").removeClass("fchat-header-clickable");
        this.$root.find(".fchat-header-name").text("Catch Me Up");
        this.$root.find(".fchat-header-status").text("").removeClass("status-active status-idlestatus-offline");
        this.$root.find(".fchat-search-bar, .fchat-group-selected-bar, .fchat-group-setup-footer,.fchat-group-name-bar, .fchat-group-info").hide();
        this.$root.find(".fchat-list, .fchat-search-results, .fchat-thread, .fchat-composer,.fchat-ask-ai-panel, .fchat-ask-ai-footer").hide();
        this.$root.find(".fchat-catchup-panel").show();

        this.refreshAIVisibility();
        this.loadCatchUp();
    },

    loadCatchUp() {
        this.$root.find(".fchat-catchup-result").hide().empty();
        this.$root.find(".fchat-catchup-loading").show();

        frappe.call({
            method: `${CHAT_API_AI_FEATURES}.catch_me_up`,
        }).then((r) => {
            this.$root.find(".fchat-catchup-loading").hide();
            this.renderCatchUp(r.message || {});
        }).catch(() => {
            this.$root.find(".fchat-catchup-loading").hide();
            this.renderCatchUp(null);
        });
    },

    renderCatchUp(data) {
        const $result = this.$root.find(".fchat-catchup-result").empty().show();

        if (!data) {
            $result.append(`<div class="fchat-catchup-empty"><span class="fchat-catchup-empty-icon">⚠️</span><span>Couldn't load your catch-up right now.Please try again.</span></div>`);
            return;
        }

        if (!data.missed_count) {
            $result.append(`<div class="fchat-catchup-empty"><span class="fchat-catchup-empty-icon">✅</span><span>${frappe.utils.escape_html(data.summary_text || "You're all caughtup.")}</span></div>`);
            return;
        }

        $result.append(`<div class="fchat-catchup-count">You missed ${data.missed_count} message${data.missed_count === 1 ? "" : "s"}</div>`);

        $result.append(`<div class="fchat-catchup-stats"><div class="fchat-catchup-stat fchat-catchup-stat-urgent"><span class="fchat-catchup-stat-num">${data.urgent_count || 0}</span><span class="fchat-catchup-stat-label">urgent</span></div><div class="fchat-catchup-stat fchat-catchup-stat-pending"><span class="fchat-catchup-stat-num">${data.pending_count || 0}</span><span class="fchat-catchup-stat-label">pending</span></div><div class="fchat-catchup-stat fchat-catchup-stat-fyi"><span class="fchat-catchup-stat-num">${data.fyi_count || 0}</span><span class="fchat-catchup-stat-label">fyi</span></div></div>`);

        if ((data.highlights || []).length) {
            const $list = $(`<ol class="fchat-catchup-highlights"></ol>`);
            data.highlights.forEach((h) => {
                $list.append(`<li>${frappe.utils.escape_html(h)}</li>`);
            });
            $result.append($list);
        }
    },

    // ----------------------------------------------------- AI Reply Assist

    runReplyAssist(action, targetLanguage) {
        const s = this.state;
        if (!s.activeUser && !s.activeGroup) return;

        const $input = this.$root.find(".fchat-composer-input");
        const text = ($input.val() || "").trim();

        if (action !== "draft" && !text) {
            this.showSystemToast("Write something first.");
            this.$root.find(".fchat-ai-assist-menu, .fchat-ai-assist-translate-row").hide();
            return;
        }

        this.$root.find(".fchat-ai-assist-menu, .fchat-ai-assist-translate-row").hide();
        this.setAIAssistLoading(true);

        const args = { action, text };
        if (s.activeIsGroup) {
            args.group = s.activeGroup;
        } else {
            args.user = s.activeUser;
        }
        if (targetLanguage) args.target_language = targetLanguage;

        frappe.call({
            method: `${CHAT_API_AI_FEATURES}.reply_assist`,
            args,
        }).then((r) => {
            this.setAIAssistLoading(false);
            const result = r.message && r.message.result;
            if (result) {
                $input.val(result).focus();
                this.autoGrowTextarea($input[0]);
                const len = result.length;
                if ($input[0].setSelectionRange) $input[0].setSelectionRange(len, len);
            }
        }).catch(() => {
            this.setAIAssistLoading(false);
            this.showSystemToast("Something went wrong. Please try again.");
        });
    },

    setAIAssistLoading(isLoading) {
        this.$root.find(".fchat-ai-assist-btn")
            .toggleClass("fchat-ai-assist-btn-loading", isLoading)
            .prop("disabled", isLoading);
    },

    applyReadOnlyState(isReadOnly) {
        const $composerInner = this.$root.find(".fchat-composer-inner");
        const $notice = this.$root.find(".fchat-readonly-notice");
        const $input = this.$root.find(".fchat-composer-input");
        const $sendBtn = this.$root.find(".fchat-send-btn");

        if (isReadOnly) {
            $composerInner.hide();
            $notice.show().text("This chat is read-only.");
            $input.prop("disabled", true);
            $sendBtn.prop("disabled", true);
        } else {
            $notice.hide();
            $composerInner.show();
            $input.prop("disabled", false);
            $sendBtn.prop("disabled", false);
        }
    },

    loadAllConversations() {
        Promise.all([
            frappe.call({ method: `${CHAT_API}.get_conversations` }),
            frappe.call({ method: `${CHAT_API}.get_groups` }),
        ]).then(([convRes, groupRes]) => {
            const conversations = convRes.message || [];
            const groups = groupRes.message || [];

            this.state.conversations = conversations;
            this.state.groups = groups;

            this.renderMergedListFromState();
            this.startPresencePoll(conversations.map((c) => c.user));
        });
    },

    renderMergedListFromState() {
        const merged = [...this.state.conversations, ...this.state.groups].sort((a, b) => {
            return new Date(b.last_time || 0) - new Date(a.last_time || 0);
        });
        this.renderList(merged);
    },

    // Locally patch one conversation's preview/unread instead of refetching // the whole list from the server — keeps live updates instant.
    patchConversationPreview(otherUser, data, incrementUnread) {
        const conv = this.state.conversations.find((c) => c.user === otherUser);

        if (!conv) {
            // First-ever message with this person — not in the list yet, needs a real fetch.
            this.loadAllConversations();
            return;
        }

        conv.last_message = data.message || "";
        conv.last_time = data.creation || new Date().toISOString();
        if (incrementUnread) {
            conv.unread = (conv.unread || 0) + 1;
        }

        this.renderMergedListFromState();
    },

    patchGroupPreview(group, data, incrementUnread) {
        const g = this.state.groups.find((gr) => gr.group === group);

        if (!g) {
            // Newly created/joined group — not in the list yet, needs a real fetch.
            this.loadAllConversations();
            return;
        }

        g.last_message = data.message || "";
        g.last_time = data.creation || new Date().toISOString();
        g.last_from = data.from_user;
        if (incrementUnread) {
            g.unread = (g.unread || 0) + 1;
        }

        this.renderMergedListFromState();
    },

    // Kept for backwards compatibility with any direct callers.
    loadConversations() {
        this.loadAllConversations();
    },

    renderList(list) {
        const $list = this.$root.find(".fchat-list").empty();

        if (!list.length) {
            $list.append(`<div class="fchat-empty">No conversations yet.<br>Tap + to startone.</div>`);
            return;
        }

        list.forEach((item) => {
            if (item.is_group) {
                $list.append(this.buildGroupRow(item));
            } else {
                $list.append(this.buildConversationRow(item));
            }
        });
    },

    buildConversationRow(c) {
        const user = c.user;
        const fullName = c.full_name || user;
        const timeFormatted = c.last_time ? formatChatDate(c.last_time) : "";

        const $row = $(`<div class="fchat-row ${c.unread ? "fchat-row-unread" : ""}"><span class="fchat-avatar-wrap">${this.avatarHtml(fullName, c.image, user, c.is_bot)}<span class="fchat-presence-dot"data-presence-for="${frappe.utils.escape_html(user)}"></span></span><div class="fchat-row-body"><div class="fchat-row-top"><span class="fchat-row-name">${frappe.utils.escape_html(fullName)}</span><span class="fchat-row-time">${timeFormatted}</span></div><div class="fchat-row-preview">${frappe.utils.escape_html((c.last_message ||"").slice(0, 60))}</div></div>${c.unread ? `<span class="fchat-row-badge">${c.unread}</span>` : ""}</div>`);

        $row.on("click", () => this.openThread(user, fullName, c.image, c.is_bot, c.enabled));
        return $row;
    },

    buildGroupRow(g) {
        const timeFormatted = g.last_time ? formatChatDate(g.last_time) : "";
        const preview = g.last_message
            ? `${frappe.utils.escape_html((g.last_message || "").slice(0, 60))}`
            : `${g.member_count} members`;

        const $row = $(`<div class="fchat-row ${g.unread ? "fchat-row-unread" : ""}"><span class="fchat-avatar-wrap">${this.groupAvatarHtml(g)}</span><div class="fchat-row-body"><div class="fchat-row-top"><span class="fchat-row-name">${frappe.utils.escape_html(g.group_name)}</span><span class="fchat-row-time">${timeFormatted}</span></div><div class="fchat-row-preview">${preview}</div></div>${g.unread ? `<span class="fchat-row-badge">${g.unread}</span>` : ""}</div>`);

        $row.on("click", () => this.openGroupThread(g.group, g));
        return $row;
    },

    groupAvatarHtml(g) {
        if (g.group_image) {
            return `<img class="fchat-avatar" src="${frappe.utils.escape_html(g.group_image)}"alt="${frappe.utils.escape_html(g.group_name || "")}" />`;
        }

        const initial = (g.group_name || "?").trim().charAt(0).toUpperCase();
        return `<span class="fchat-avatarfchat-avatar-group">${frappe.utils.escape_html(initial)}</span>`;
    },

    runSearch(txt) {
        frappe.call({
            method: `${CHAT_API}.search_users`,
            args: { txt: (txt || "").trim() },
        }).then((r) => {
            const $res = this.$root.find(".fchat-search-results").empty();
            const users = r.message || [];

            users.forEach((u) => {
                const user = u.user;
                const fullName = u.full_name || user;

                const $row = $(`<div class="fchat-row"><span class="fchat-avatar-wrap">${this.avatarHtml(fullName, u.image, user,u.is_bot)}</span><div class="fchat-row-body"><div class="fchat-row-top"><span class="fchat-row-name">${frappe.utils.escape_html(fullName)}</span></div><div class="fchat-row-preview">${frappe.utils.escape_html(user)}</div></div></div>`);

                $row.on("click", () => this.openThread(user, fullName, u.image, u.is_bot,
u.enabled));
                $res.append($row);
            });

            if (!users.length) {
                $res.append(`<div class="fchat-empty">No users found</div>`);
            }
        });
    },

    loadMessages(user) {
        frappe.call({
            method: `${CHAT_API}.get_messages`,
            args: { user },
        }).then((r) => {
            this.state.messages = r.message || [];
            this.renderThread();
            this.refreshUnread();
        });
    },

    renderThread() {
        const $wrap = this.$root.find(".fchat-thread-messages").empty();
        let lastDayLabel = null;

        this.state.messages.forEach((m) => {
            const dateLabel = formatChatDate(m.creation);
            const timeStr = formatMsgTime(m.creation);

            if (dateLabel !== lastDayLabel) {
                $wrap.append(`<div class="fchat-day-sep">${dateLabel}</div>`);
                lastDayLabel = dateLabel;
            }

            const mine = m.from_user === frappe.session.user;
            const bot = m.message_type === "Notification";
            const isGroup = this.state.activeIsGroup;
            const hasText = !!(m.message && m.message.trim());
            const attachmentsHtml = this.renderMessageAttachments(m);
            const mediaOnly = !hasText && !!attachmentsHtml;

            const senderLabel = isGroup && !mine
                ? `<span class="fchat-msg-sender">${frappe.utils.escape_html(m.from_full_name|| m.from_user || "")}</span>`
                : "";

            $wrap.append(`<div class="fchat-msg ${mine ? "fchat-msg-mine" : "fchat-msg-theirs"} ${bot ?"fchat-msg-bot" : ""}">${senderLabel}<div class="fchat-msg-bubble ${mediaOnly ? "fchat-msg-bubble-media-only" :""}">${attachmentsHtml}${hasText ? `<span
class="fchat-msg-text">${frappe.utils.escape_html(m.message)}</span>` : ""}<span class="fchat-msg-meta"><span class="fchat-msg-time">${timeStr}</span>${mine && !isGroup ? `<span
class="fchat-tick">${this.getTickSvg(m)}</span>` : ""}</span></div></div>`);
        });

        if ($wrap[0]) {
            $wrap.scrollTop($wrap[0].scrollHeight);
        }
    },

    getTickSvg(msg) {
        if (msg.seen) {
            return `<svg class="fchat-tick-icon fchat-tick-read" viewBox="0 0 16 11"><path d="M11.0001 0.666687L4.58341 7.08335L1.83341 4.33335L0.6667485.50002L4.58341 9.41669L12.1667 1.83335L11.0001 0.666687ZM15.16671.83335L7.58341 9.41669L5.83341 7.66669L7.00008 6.50002L7.58341 7.08335L14.00010.666687L15.1667 1.83335Z"/></svg>`;
        } else if (msg.delivered) {
            return `<svg class="fchat-tick-icon fchat-tick-delivered" viewBox="0 0 16 11"><path d="M11.0001 0.666687L4.58341 7.08335L1.83341 4.33335L0.6667485.50002L4.58341 9.41669L12.1667 1.83335L11.0001 0.666687ZM15.16671.83335L7.58341 9.41669L5.83341 7.66669L7.00008 6.50002L7.58341 7.08335L14.00010.666687L15.1667 1.83335Z"/></svg>`;
        } else {
            return `<svg class="fchat-tick-icon fchat-tick-sent" viewBox="0 0 12 11"><path d="M11.0001 0.666687L4.58341 7.08335L1.83341 4.33335L0.6667485.50002L4.58341 9.41669L12.1667 1.83335L11.0001 0.666687Z"/></svg>`;
        }
    },

    sendCurrentMessage() {
        const s = this.state;

        const $input = this.$root.find(".fchat-composer-input");
        const message = ($input.val() || "").trim();

        const stillUploading = s.pendingAttachments.some((a) => a.status === "uploading");
        if (stillUploading) {
            this.showSystemToast("Please wait for attachments to finish uploading.");
            return;
        }

        const readyAttachments = s.pendingAttachments.filter((a) => a.status === "done" &&
a.file_url);

        if (!message && !readyAttachments.length) return;

        const attachmentsPayload = readyAttachments.map((a) => ({
            file_url: a.file_url,
            file_name: a.file_name,
            file_type: a.file_type,
            file_size: a.file_size,
        }));

        if (s.activeIsGroup && s.activeGroup) {
            $input.val("");
            $input[0].style.height = "";
            $input[0].style.overflowY = "hidden";
            this.clearAttachmentTray();

            frappe.call({
                method: `${CHAT_API}.send_group_message`,
                args: { group: s.activeGroup, message, attachments: attachmentsPayload },
            }).then((r) => {
                if (r.message) {
                    this.state.messages.push(r.message);
                    this.renderThread();
                }
            });
            return;
        }

        if (s.activeUserData.isReadOnly) return;
        if (!s.activeUser) return;

        $input.val("");
        $input[0].style.height = "";
        $input[0].style.overflowY = "hidden";
        this.clearAttachmentTray();

        frappe.call({
            method: `${CHAT_API}.send_message`,
            args: { to_user: s.activeUser, message, attachments: attachmentsPayload },
        }).then((r) => {
            if (r.message) {
                this.state.messages.push(r.message);
                this.renderThread();
            }
        });
    },

    // ----------------------------------------------------------- Attachments

    handleFilesSelected(fileList) {
        const MAX_SIZE = 25 * 1024 * 1024; // 25MB, Gmail-style cap

        Array.from(fileList || []).forEach((file) => {
            if (file.size > MAX_SIZE) {
                this.showSystemToast(`${file.name} is larger than 25MB and can't be attached.`);
                return;
            }
            this.addPendingAttachment(file);
        });
    },

    addPendingAttachment(file) {
        const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const isImage = !!(file.type && file.type.indexOf("image/") === 0);

        const item = {
            id,
            file,
            file_name: file.name,
            file_type: file.type || "",
            file_size: file.size,
            status: "uploading",
            progress: 0,
            file_url: null,
            previewUrl: isImage ? URL.createObjectURL(file) : null,
        };

        this.state.pendingAttachments.push(item);
        this.renderAttachmentTray();
        this.uploadPendingAttachment(item);
    },

    uploadPendingAttachment(item) {
        const formData = new FormData();
        formData.append("file", item.file);
        formData.append("is_private", 0);

        $.ajax({
            url: "/api/method/upload_file",
            type: "POST",
            data: formData,
            processData: false,
            contentType: false,
            headers: { "X-Frappe-CSRF-Token": frappe.csrf_token },
            xhr: () => {
                const xhr = new window.XMLHttpRequest();
                xhr.upload.addEventListener("progress", (e) => {
                    if (e.lengthComputable) {
                        item.progress = Math.round((e.loaded / e.total) * 100);
                        this.updateAttachmentChipProgress(item);
                    }
                });
                return xhr;
            },
        }).then((r) => {
            const fileUrl = r.message && r.message.file_url;
            if (!fileUrl) throw new Error("Upload failed");
            item.file_url = fileUrl;
            item.status = "done";
            item.progress = 100;
            this.renderAttachmentTray();
        }).catch(() => {
            item.status = "error";
            this.renderAttachmentTray();
        });
    },

    updateAttachmentChipProgress(item) {
        const $chip = this.$root.find(`.fchat-att-chip[data-id="${item.id}"]`);
        $chip.find(".fchat-att-progress-fill").css("width", `${item.progress}%`);
    },

    removePendingAttachment(id) {
        const s = this.state;
        const item = s.pendingAttachments.find((a) => a.id === id);
        if (item && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        s.pendingAttachments = s.pendingAttachments.filter((a) => a.id !== id);
        this.renderAttachmentTray();
    },

    clearAttachmentTray() {
        this.state.pendingAttachments.forEach((a) => {
            if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        });
        this.state.pendingAttachments = [];
        this.renderAttachmentTray();
    },

    renderAttachmentTray() {
        const s = this.state;
        const $tray = this.$root.find(".fchat-attachment-tray");

        if (!s.pendingAttachments.length) {
            $tray.hide().empty();
            return;
        }

        $tray.empty().show();

        s.pendingAttachments.forEach((item) => {
            const $chip = $(`<div class="fchat-att-chip" data-id="${item.id}"></div>`);

            if (item.previewUrl) {
                $chip.append(`<img class="fchat-att-thumb" src="${item.previewUrl}" />`);
            } else {
                $chip.append(this.fileIconSvg(item.file_type, item.file_name));
            }

            $chip.append(`<div class="fchat-att-meta"><span class="fchat-att-name"title="${frappe.utils.escape_html(item.file_name)}">${frappe.utils.escape_html(item.file_name)}</span><span class="fchat-att-size">${this.formatFileSize(item.file_size)}</span></div>`);

            if (item.status === "uploading") {
                $chip.append(`<div class="fchat-att-progress"><div class="fchat-att-progress-fill"style="width:${item.progress}%;"></div></div>`);
            } else if (item.status === "error") {
                $chip.addClass("fchat-att-error");
                $chip.append(`<span class="fchat-att-error-label">Failed</span>`);
            }

            const $removeBtn = $(`<button class="fchat-att-remove">&times;</button>`);
            $removeBtn.on("click", () => this.removePendingAttachment(item.id));
            $chip.append($removeBtn);

            $tray.append($chip);
        });
    },

    fileIconSvg(fileType, fileName) {
        const ext = (fileName || "").split(".").pop().toLowerCase();
        const map = {
            pdf: "📕", doc: "📄", docx: "📄", xls: "📊", xlsx: "📊",
            csv: "📊", ppt: "📙", pptx: "📙", zip: "🗜️", rar: "🗜️",
            "7z": "🗜️", mp3: "🎵", wav: "🎵", m4a: "🎵", mp4: "🎬",
            mov: "🎬", avi: "🎬", txt: "📃", json: "🧾",
        };
        return `<span class="fchat-att-icon">${map[ext] || "📎"}</span>`;
    },

    formatFileSize(bytes) {
        if (!bytes) return "";
        const units = ["B", "KB", "MB", "GB"];
        let size = bytes;
        let i = 0;
        while (size >= 1024 && i < units.length - 1) {
            size /= 1024;
            i++;
        }
        return `${size.toFixed(size < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
    },

    renderMessageAttachments(m) {
        const attachments = m.attachments || [];
        if (!attachments.length) return "";

        const images = attachments.filter((a) => (a.file_type || "").indexOf("image/") === 0);
        const files = attachments.filter((a) => (a.file_type || "").indexOf("image/") !== 0);

        let html = "";

        if (images.length) {
            const shown = images.slice(0, 4);
            const extra = images.length - shown.length;

            html += `<div class="fchat-att-grid fchat-att-grid-${shown.length}">`;
            shown.forEach((img, idx) => {
                const isLastWithOverflow = extra > 0 && idx === shown.length - 1;
                html += `<div class="fchat-att-grid-item"data-msg-id="${frappe.utils.escape_html(m.name)}" data-img-idx="${idx}"><img src="${frappe.utils.escape_html(img.file_url)}" loading="lazy" />${isLastWithOverflow ? `<div class="fchat-att-grid-overlay">+${extra}</div>` :""}</div>`;
            });
            html += `</div>`;
        }

        files.forEach((f) => {
            html += `<a class="fchat-att-file-card" href="${frappe.utils.escape_html(f.file_url)}"target="_blank" rel="noopener">${this.fileIconSvg(f.file_type, f.file_name)}<span class="fchat-att-file-meta"><span class="fchat-att-file-name">${frappe.utils.escape_html(f.file_name ||"File")}</span><span class="fchat-att-file-size">${this.formatFileSize(f.file_size)}</span></span><span class="fchat-att-download-icon">⬇</span></a>`;
        });

        return html;
    },

    openLightbox(images, startIdx) {
        if (!images || !images.length) return;
        let idx = startIdx || 0;

        const $overlay = $(`<div class="fchat-lightbox"><button class="fchat-lightbox-close">&times;</button><button class="fchat-lightbox-prev">&#10094;</button><img class="fchat-lightbox-img" src="" /><button class="fchat-lightbox-next">&#10095;</button><a class="fchat-lightbox-download" download target="_blank"rel="noopener">Download</a></div>`);

        const close = () => {
            $overlay.remove();
            $(document).off("keydown.fchat_lightbox");
        };

        const update = () => {
            $overlay.find(".fchat-lightbox-img").attr("src", images[idx].file_url);
            $overlay.find(".fchat-lightbox-download").attr("href", images[idx].file_url);
            $overlay.find(".fchat-lightbox-prev, .fchat-lightbox-next").toggle(images.length > 1);
        };

        $overlay.find(".fchat-lightbox-close").on("click", close);
        $overlay.on("click", (e) => {
            if (e.target === $overlay[0]) close();
        });
        $overlay.find(".fchat-lightbox-prev").on("click", (e) => {
            e.stopPropagation();
            idx = (idx - 1 + images.length) % images.length;
            update();
        });
        $overlay.find(".fchat-lightbox-next").on("click", (e) => {
            e.stopPropagation();
            idx = (idx + 1) % images.length;
            update();
        });

        $(document).on("keydown.fchat_lightbox", (e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowLeft") { idx = (idx - 1 + images.length) % images.length; update();
}
            if (e.key === "ArrowRight") { idx = (idx + 1) % images.length; update(); }
        });

        update();
        $("body").append($overlay);
        requestAnimationFrame(() => $overlay.addClass("fchat-lightbox-in"));
    },

    autoGrowTextarea(el) {
        if (!el) return;
        const MAX_HEIGHT = 120; // ~5 lines, matches CSS max-height
        el.style.height = "auto";
        const next = Math.min(el.scrollHeight, MAX_HEIGHT);
        el.style.height = `${next}px`;
        el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    },

    resetComposerHeight(selector) {
        const el = this.$root.find(selector)[0];
        if (el) {
            el.style.height = "";
            el.style.overflowY = "hidden";
        }
    },

    notifyTyping: frappe.utils.debounce(function () {
        const s = messaging.chat.state;
        if (!s.activeUser || s.activeUserData.isReadOnly) return;

        frappe.call({
            method: `${CHAT_API}.set_typing`,
            args: { to_user: s.activeUser },
        });
    }, 800),

    onNewMessage(data) {
        const s = this.state;
        const me = frappe.session.user;

        if (!data) return;

        const otherParty = data.from_user === me ? data.to_user : data.from_user;

        if (data.to_user === me) {
            this.playNotificationSound();
        }

        if (s.open && s.view === "thread" && s.activeUser === otherParty) {
            data.delivered = true;
            s.messages.push(data);
            this.renderThread();
            this.markSeen(otherParty);
        } else if (data.to_user === me) {
            this.showToast(data);
            this.bumpBadge();
        }

        if (s.open && s.view === "list") {
            this.patchConversationPreview(otherParty, data, data.to_user === me);
        }
    },

    onSeen(data) {
        const s = this.state;
        if (s.open && s.view === "thread" && s.activeUser === data.from_user) {
            s.messages.forEach((m) => {
                if (m.from_user === frappe.session.user) {
                    m.seen = 1;
                }
            });
            this.renderThread();
        }
    },

    onTyping(data) {
        const s = this.state;
        if (!data || s.activeUser !== data.from_user || s.activeUserData.isReadOnly) return;

        const $ind = this.$root.find(".fchat-typing-indicator").show();
        clearTimeout(this._typingTimeout);
        this._typingTimeout = setTimeout(() => $ind.hide(), 2000);
    },

    markSeen(user) {
        if (!user) return;
        frappe.call({
            method: `${CHAT_API}.mark_seen`,
            args: { user },
        });
    },

    showToast(data) {
        const fromUser = data.from_user || "";
        const name = data.from_full_name || data.full_name || fromUser;

        const $toast = $(`<div class="fchat-toast"><div class="fchat-toast-title">${frappe.utils.escape_html(name)}</div><div class="fchat-toast-msg">${frappe.utils.escape_html((data.message ||"").slice(0, 80))}</div></div>`);

        $toast.on("click", (e) => {
            e.stopPropagation();
            this.togglePanel(true);
            this.openThread(fromUser, name, data.from_image, data.is_bot, data.enabled);
            $toast.remove();
        });

        $("body").append($toast);

        requestAnimationFrame(() => $toast.addClass("fchat-toast-in"));

        setTimeout(() => {
            $toast.removeClass("fchat-toast-in");
            setTimeout(() => $toast.remove(), 300);
        }, 5000);
    },

    refreshUnread() {
        frappe.call({
            method: `${CHAT_API}.get_unread_count`,
        }).then((r) => {
            this.state.unread = parseInt(r.message || 0, 10);
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

    startHeartbeat() {
        this.heartbeat();
        if (this.state.heartbeatTimer) clearInterval(this.state.heartbeatTimer);
        this.state.heartbeatTimer = setInterval(() => this.heartbeat(), 15000);
    },

    heartbeat() {
        if (frappe.session.user === "Guest") return;

        frappe.call({
            method: `${CHAT_API}.heartbeat`,
            args: {
                status: this.state.userPresence // 'active' | 'idle'
            }
        });
    },

    startPresencePoll(users) {
        this.stopPresencePoll();

        users = [...new Set((users || []).filter((u) => u && u !== frappe.session.user && u !==
NOTIFICATION_BOT_USER))];
        if (!users.length) return;

        const poll = () => {
            frappe.call({
                method: `${CHAT_API}.get_online_status`,
                args: { users },
            }).then((r) => {
                const statuses = r.message || {};

                Object.keys(statuses).forEach((u) => {
                    // Raw status string returned from server ('active', 'idle', or 'offline')
                    let statusStr = statuses[u];

                    // Fallback formatting for boolean responses
                    if (typeof statusStr === 'boolean') {
                        statusStr = statusStr ? 'active' : 'offline';
                    }

                    statusStr = (statusStr || 'offline').toLowerCase();

                    const selector = `.fchat-presence-dot[data-presence-for="${CSS.escape(u)}"]`;

                    this.$root.find(selector)
                        .removeClass("status-active status-idle status-offline")
                        .addClass(`status-${statusStr}`);

                    if (this.state.activeUser === u) {
                        let labelText = "Offline";
                        if (statusStr === "active") labelText = "Active now";
                        else if (statusStr === "idle") labelText = "Idle";

                        this.$root.find(".fchat-header-status")
                            .text(labelText)
                            .removeClass("status-active status-idle status-offline")
                            .addClass(`status-${statusStr}`);
                    }
                });
            });
        };

        poll();
        this.state.presencePollTimer = setInterval(poll, 10000);
    },

    stopPresencePoll() {
        if (this.state.presencePollTimer) {
            clearInterval(this.state.presencePollTimer);
            this.state.presencePollTimer = null;
        }
    },

    avatarHtml(fullName, image, user, isBot) {
        if (isBot || user === NOTIFICATION_BOT_USER) {
            return `<span class="fchat-avatar fchat-avatar-bot">🤖</span>`;
        }

        if (image) {
            return `<img class="fchat-avatar" src="${frappe.utils.escape_html(image)}"alt="${frappe.utils.escape_html(fullName || user || "")}" />`;
        }

        const initial = (fullName || user || "?").trim().charAt(0).toUpperCase();
        return `<span class="fchat-avatarfchat-avatar-fallback">${frappe.utils.escape_html(initial)}</span>`;
    },
};

$(document).ready(() => {
    frappe.after_ajax(() => {
        messaging.chat.init();
    });
});


