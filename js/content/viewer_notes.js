// ===========================================================
// viewer_notes.js - 聊天室觀眾筆記 (前台)
// 用途：在直播聊天室 (含直播控制室內嵌的聊天室、彈出式聊天室) 的作者名稱旁
//       顯示標籤、評分、備註記號與自訂暱稱，並提供就地編輯的小面板。
// 說明：資料由背景服務保存在本機 IndexedDB；這裡只負責顯示與送出修改。
// ===========================================================

const ViewerNotes = {
  SETTINGS_KEY: "yt_viewer_notes_settings",
  REV_KEY: "yt_viewer_notes_rev",
  BOX_CLASS: "rn-vn-box",
  AVATAR_ATTR: "data-rn-vn-avatar",
  PANEL_ID: "rn-vn-panel",
  HOSTS: [
    "yt-live-chat-text-message-renderer",
    "yt-live-chat-paid-message-renderer",
    "yt-live-chat-paid-sticker-renderer",
    "yt-live-chat-membership-item-renderer",
    "ytd-sponsorships-live-chat-gift-purchase-announcement-renderer",
  ],
  BATCH_DELAY: 60,
  MAX_CACHE: 3000,
  ERROR_LIMIT: 20,

  enabled: true,
  fuseTripped: false,
  started: false,
  observer: null,
  rev: 0,
  errors: 0,
  cache: new Map(), // idKey -> record | null
  tags: [],
  queue: new Set(),
  queueTimer: null,
  pendingIds: new Map(), // idKey -> identity
  waiting: new Map(), // idKey -> Set<host>
  lookupTimer: null,
  panel: null,
  panelIdentity: null,
  dock: null,
  dockOpen: false,
  dockTab: "recent",
  dockTimer: null,
  recent: [], // 最近發言且有筆記的觀眾 (新的在前)
  MAX_RECENT: 8,
  avatarHandler: null,

  init: function () {
    if (!location.pathname.startsWith("/live_chat")) return;
    this.hostSelector = this.HOSTS.join(",");
    const fuseKey = window.AppConfig.FUSE_FE_KEY;
    const apply = () => {
      if (this.enabled && !this.fuseTripped) this.start();
      else this.stop();
    };
    try {
      chrome.storage.local.get([this.SETTINGS_KEY, fuseKey], (res) => {
        const s = res[this.SETTINGS_KEY];
        this.enabled = !(s && s.enabled === false);
        this.dockOpen = !!(s && s.dockOpen);
        this.fuseTripped = !!(res[fuseKey] && res[fuseKey].status === "TRIPPED");
        const ready = typeof I18n !== "undefined" ? I18n.init() : Promise.resolve();
        ready.then(apply);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[this.SETTINGS_KEY]) {
          const s = changes[this.SETTINGS_KEY].newValue;
          this.enabled = !(s && s.enabled === false);
          if (!!(s && s.dockOpen) !== this.dockOpen) {
            this.dockOpen = !!(s && s.dockOpen);
            this.renderDock();
          }
          apply();
        }
        if (changes[fuseKey]) {
          this.fuseTripped = !!(changes[fuseKey].newValue && changes[fuseKey].newValue.status === "TRIPPED");
          apply();
        }
        if (changes[this.REV_KEY]) this.refreshAll();
      });
    } catch (e) {
      // 擴充功能內容已失效 (更新或停用)：維持頁面原樣
    }
  },

  start: function () {
    if (this.started || !document.body) return;
    this.started = true;
    this.injectStyle();
    this.bindAvatar();
    this.scan(document.body);
    this.renderDock();
    this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-rn-cid"],
    });
  },

  stop: function () {
    if (!this.started) return;
    this.started = false;
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    this.queue.clear();
    this.closePanel();
    if (this.dock) this.dock.remove();
    this.dock = null;
    this.recent = [];
    if (this.avatarHandler) {
      ["click", "keydown"].forEach((type) => document.removeEventListener(type, this.avatarHandler, true));
      this.avatarHandler = null;
    }
    document.querySelectorAll("." + this.BOX_CLASS).forEach((n) => n.remove());
    document.querySelectorAll("[" + this.AVATAR_ATTR + "]").forEach((a) => this.releaseAvatar(a));
    document.querySelectorAll("[data-rn-vn-key]").forEach((host) => {
      delete host.dataset.rnVnKey;
      delete host.dataset.rnVnRev;
      delete host.dataset.rnVnHas;
      host.removeAttribute("data-rn-vn-custom");
    });
  },

  injectStyle: function () {
    if (document.getElementById("rn-vn-style")) return;
    const style = document.createElement("style");
    style.id = "rn-vn-style";
    const hover = this.HOSTS.map((h) => `${h}:hover .rn-vn-edit`).join(",");
    const avatarHover = this.HOSTS.map((h) => `${h}:hover [${this.AVATAR_ATTR}]::after`).join(",");
    style.textContent = `
[data-rn-vn-custom="1"] #author-name,[data-rn-vn-custom="1"] .rn-restored-name{display:none !important}
.rn-vn-box{display:inline-flex;flex-wrap:wrap;align-items:center;gap:3px;margin:0 4px 0 0;vertical-align:middle}
.rn-vn-box:empty{display:none}
.rn-vn-name{margin-right:2px}
.rn-vn-chip{display:inline-block;padding:0 5px;border-radius:8px;font-size:11px;line-height:16px;font-weight:500;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis;background:rgba(128,128,128,.25);color:inherit}
.rn-vn-chip.rn-vn-ext{border:1px dashed rgba(128,128,128,.7)}
.rn-vn-score{background:#ffe082;color:#111}
.rn-vn-score.rn-vn-neg{background:#ef9a9a}
.rn-vn-edit{all:unset;cursor:pointer;font-size:12px;line-height:16px;padding:0 3px;border-radius:4px;opacity:0;transition:opacity .1s}
.rn-vn-edit:focus-visible{opacity:1;outline:1px solid currentColor}
${hover}{opacity:.75}
[${this.AVATAR_ATTR}]{cursor:pointer;position:relative}
[${this.AVATAR_ATTR}]::after{content:"✎";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:13px;background:rgba(0,0,0,.55);color:#fff;opacity:0;transition:opacity .1s;pointer-events:none}
[${this.AVATAR_ATTR}]:focus-visible{outline:2px solid #3ea6ff;outline-offset:1px;border-radius:50%}
${avatarHover},[${this.AVATAR_ATTR}]:focus-visible::after{opacity:1}
#rn-vn-panel{position:fixed;z-index:2147483646;width:280px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:10px 12px;border-radius:10px;font:13px/1.5 Roboto,Arial,sans-serif;background:#fff;color:#222;border:1px solid rgba(0,0,0,.15);box-shadow:0 8px 28px rgba(0,0,0,.3)}
#rn-vn-panel.rn-vn-dark{background:#212121;color:#eee;border-color:rgba(255,255,255,.15)}
#rn-vn-panel h4{margin:8px 0 4px;font-size:12px;font-weight:600;opacity:.75}
#rn-vn-panel .rn-vn-head{display:flex;align-items:flex-start;gap:6px}
#rn-vn-panel .rn-vn-title{flex:1;min-width:0;font-weight:600;word-break:break-word}
#rn-vn-panel .rn-vn-sub{font:11px monospace;opacity:.7;word-break:break-all}
#rn-vn-panel input[type=text]{box-sizing:border-box;width:100%;padding:4px 6px;border:1px solid rgba(128,128,128,.5);border-radius:6px;background:transparent;color:inherit;font:inherit}
#rn-vn-panel button{cursor:pointer;font:inherit;color:inherit;background:rgba(128,128,128,.2);border:1px solid rgba(128,128,128,.4);border-radius:6px;padding:2px 8px}
#rn-vn-panel button:hover{background:rgba(128,128,128,.35)}
#rn-vn-panel .rn-vn-row{display:flex;align-items:center;gap:6px}
#rn-vn-panel .rn-vn-tags{display:flex;flex-wrap:wrap;gap:4px}
#rn-vn-panel .rn-vn-tag{border-radius:10px;padding:1px 8px;opacity:.45}
#rn-vn-panel .rn-vn-tag[aria-pressed=true]{opacity:1;outline:2px solid #3ea6ff}
#rn-vn-panel .rn-vn-note{display:flex;gap:6px;align-items:flex-start;margin-bottom:3px}
#rn-vn-panel .rn-vn-note span{flex:1;word-break:break-word}
#rn-vn-panel input[type=color]{width:28px;height:24px;padding:0;border:none;background:none}
#rn-vn-panel .rn-vn-scoreval{min-width:36px;text-align:center;font-weight:600}
#rn-vn-dock{position:fixed;right:8px;bottom:64px;z-index:2147483645;font:12px/1.45 Roboto,Arial,sans-serif;color:#222}
#rn-vn-dock.rn-vn-dark{color:#eee}
#rn-vn-dock button{all:unset;cursor:pointer;box-sizing:border-box}
#rn-vn-dock button:focus-visible{outline:2px solid #3ea6ff}
#rn-vn-dock .rn-vn-dock-toggle{display:block;margin-left:auto;padding:3px 9px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,.2);box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.75}
#rn-vn-dock .rn-vn-dock-toggle:hover{opacity:1}
#rn-vn-dock.rn-vn-dark .rn-vn-dock-toggle,#rn-vn-dock.rn-vn-dark .rn-vn-dock-body{background:#212121;border-color:rgba(255,255,255,.2)}
#rn-vn-dock .rn-vn-dock-body{width:290px;max-width:calc(100vw - 16px);max-height:45vh;overflow:auto;margin-bottom:6px;padding:8px 10px;border-radius:10px;background:#fff;border:1px solid rgba(0,0,0,.15);box-shadow:0 8px 28px rgba(0,0,0,.3)}
#rn-vn-dock .rn-vn-dock-tabs{display:flex;gap:4px;margin-bottom:6px}
#rn-vn-dock .rn-vn-dock-tabs button{padding:2px 10px;border-radius:10px;background:rgba(128,128,128,.18)}
#rn-vn-dock .rn-vn-dock-tabs button[aria-selected=true]{background:#3ea6ff;color:#111}
#rn-vn-dock .rn-vn-dock-item{padding:5px 0;border-top:1px solid rgba(128,128,128,.25)}
#rn-vn-dock .rn-vn-dock-item:first-of-type{border-top:none}
#rn-vn-dock .rn-vn-dock-name{font-weight:600;font-size:13px;margin-right:4px}
#rn-vn-dock .rn-vn-dock-note{word-break:break-word}
#rn-vn-dock .rn-vn-dock-empty{opacity:.7;padding:6px 0}
#rn-vn-dock .rn-vn-chip{margin-right:3px}
`;
    (document.head || document.documentElement).appendChild(style);
  },

  // ---------------------------------------------------------------- 掃描
  onMutations: function (mutations) {
    let found = false;
    for (const m of mutations) {
      const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!target || !target.closest) continue;
      // 自己插入的節點與編輯面板不處理
      if (target.closest("." + this.BOX_CLASS) || target.closest("#" + this.PANEL_ID) || target.closest("#rn-vn-dock")) continue;
      const host = target.closest(this.hostSelector);
      if (host) {
        this.queue.add(host);
        found = true;
        continue;
      }
      if (m.type !== "childList") continue;
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(this.hostSelector)) {
          this.queue.add(node);
          found = true;
        } else if (node.firstElementChild) {
          node.querySelectorAll(this.hostSelector).forEach((h) => {
            this.queue.add(h);
            found = true;
          });
        }
      }
    }
    if (found && !this.queueTimer) {
      this.queueTimer = setTimeout(() => {
        this.queueTimer = null;
        const hosts = this.queue;
        this.queue = new Set();
        hosts.forEach((h) => this.processHost(h));
      }, this.BATCH_DELAY);
    }
  },

  scan: function (root) {
    root.querySelectorAll(this.hostSelector).forEach((h) => this.processHost(h));
  },

  refreshAll: function () {
    this.rev++;
    this.cache.clear();
    if (!this.started) return;
    this.scan(document.body);
    if (this.panel && this.panelIdentity) this.openPanel(this.panelIdentity, null);
    if (this.dockOpen) this.renderDock();
  },

  identityOf: function (host) {
    const author = host.querySelector("#author-name");
    if (!author) return null;
    const cid = host.getAttribute("data-rn-cid") || "";
    let handle = author.dataset.rnTargetHandle || "";
    if (!handle) {
      const raw = (author.textContent || "").trim();
      if (/^@[^\s]+$/.test(raw)) handle = raw;
    }
    const channelId = ViewerModel.normalizeChannelId(cid);
    const normHandle = ViewerModel.normalizeHandle(handle);
    if (!channelId && !normHandle) return null;
    // 還原後的頻道名稱 (若暱稱還原已完成)，存起來方便在管理頁辨識
    const dual = author.previousElementSibling;
    const name =
      (dual && dual.classList && dual.classList.contains("rn-restored-name") && dual.dataset.rnName) ||
      (author.dataset.rnReplaced === "yes" && author.dataset.rnName) ||
      "";
    return {
      channelId,
      handle: normHandle,
      rawHandle: handle || "",
      name,
      author,
      idKey: (channelId || "") + "|" + (normHandle || ""),
    };
  },

  processHost: function (host) {
    if (!this.started || !host.isConnected) return;
    try {
      const identity = this.identityOf(host);
      if (!identity) {
        this.clearHost(host);
        return;
      }
      if (host.dataset.rnVnKey === identity.idKey && host.dataset.rnVnRev === String(this.rev)) return;
      if (this.cache.has(identity.idKey)) {
        this.render(host, identity, this.cache.get(identity.idKey));
        return;
      }
      // 元素換人時先清掉上一位的內容，等查詢結果回來再畫
      if (host.dataset.rnVnKey && host.dataset.rnVnKey !== identity.idKey) this.clearHost(host);
      this.requestLookup(identity, host);
    } catch (e) {
      this.reportError();
    }
  },

  reportError: function () {
    this.errors++;
    if (this.errors >= this.ERROR_LIMIT) this.stop();
  },

  requestLookup: function (identity, host) {
    this.pendingIds.set(identity.idKey, this.plain(identity));
    if (!this.waiting.has(identity.idKey)) this.waiting.set(identity.idKey, new Set());
    this.waiting.get(identity.idKey).add(host);
    if (this.lookupTimer) return;
    this.lookupTimer = setTimeout(() => {
      this.lookupTimer = null;
      const entries = [...this.pendingIds.entries()];
      const waiting = this.waiting;
      this.pendingIds = new Map();
      this.waiting = new Map();
      this.send({ type: "VN_LOOKUP", ids: entries.map((e) => e[1]) }).then((res) => {
        if (!res) return;
        this.tags = res.tags || [];
        if (this.cache.size > this.MAX_CACHE) this.cache.clear();
        entries.forEach(([idKey], i) => {
          this.cache.set(idKey, res.records[i] || null);
          (waiting.get(idKey) || []).forEach((host) => this.processHost(host));
        });
      });
    }, this.BATCH_DELAY);
  },

  plain: function (identity) {
    return { channelId: identity.channelId, handle: identity.handle, rawHandle: identity.rawHandle };
  },

  send: function (message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError || !response || !response.ok) resolve(null);
          else resolve(response.data === undefined ? true : response.data);
        });
      } catch (e) {
        resolve(null);
      }
    });
  },

  // ---------------------------------------------------------------- 顯示
  clearHost: function (host) {
    host.querySelectorAll("." + this.BOX_CLASS).forEach((n) => n.remove());
    host.querySelectorAll("[" + this.AVATAR_ATTR + "]").forEach((a) => this.releaseAvatar(a));
    host.removeAttribute("data-rn-vn-custom");
    delete host.dataset.rnVnKey;
    delete host.dataset.rnVnRev;
    delete host.dataset.rnVnHas;
  },

  chip: function (label, color, extra) {
    const el = document.createElement("span");
    el.className = "rn-vn-chip" + (extra ? " " + extra : "");
    el.textContent = label;
    if (color) {
      el.style.background = color;
      el.style.color = this.contrastText(color);
    }
    return el;
  },

  contrastText: function (hex) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? "#111111" : "#ffffff";
  },

  render: function (host, identity, record) {
    const author = identity.author;
    let box = author.nextElementSibling;
    if (!box || !box.classList || !box.classList.contains(this.BOX_CLASS)) {
      host.querySelectorAll("." + this.BOX_CLASS).forEach((n) => n.remove());
      box = document.createElement("span");
      box.className = this.BOX_CLASS;
      author.insertAdjacentElement("afterend", box);
    }
    box.replaceChildren();

    if (record && record.customNickname) {
      const name = document.createElement("span");
      name.className = "rn-vn-name";
      name.textContent = record.customNickname;
      if (typeof TooltipManager !== "undefined") {
        TooltipManager.copyNativeStyle(author, name);
        const original = identity.name || (record.ext && record.ext.name) || record.name;
        TooltipManager.attachData(
          name,
          identity.handle || "",
          original ? `${record.customNickname} (${original})` : record.customNickname,
          0,
          false
        );
      }
      box.appendChild(name);
      host.setAttribute("data-rn-vn-custom", "1");
    } else {
      host.removeAttribute("data-rn-vn-custom");
    }

    // 這則訊息第一次帶出筆記時，列入「最近發言」
    if (record && (host.dataset.rnVnKey !== identity.idKey || host.dataset.rnVnHas !== "1")) this.noteRecent(identity);
    if (record) host.dataset.rnVnHas = "1";
    else delete host.dataset.rnVnHas;

    if (record) {
      const defs = new Map(this.tags.map((t) => [t.id, t]));
      record.tagIds.forEach((id) => {
        const def = defs.get(id);
        if (def) box.appendChild(this.chip(def.label, def.color));
      });
      if (record.ext) {
        record.ext.tags.forEach((t) => box.appendChild(this.chip(t.label, t.color, "rn-vn-ext")));
        record.ext.aiTags.forEach((t) => box.appendChild(this.chip(t, "", "rn-vn-ext")));
      }
      if (record.score !== 0) {
        const score = this.chip(
          (record.score > 0 ? "+" : "") + record.score,
          "",
          "rn-vn-score" + (record.score < 0 ? " rn-vn-neg" : "")
        );
        score.title = this.t("vn_score");
        box.appendChild(score);
      }
      if (record.notes.length > 0) {
        const note = this.chip("📌" + (record.notes.length > 1 ? record.notes.length : ""), "", "rn-vn-notechip");
        note.title = record.notes.join("\n");
        box.appendChild(note);
      }
    }

    // 編輯入口：點頭像 (滑過訊息時頭像上會出現 ✎)；找不到頭像時才在名稱旁放 ✎ 按鈕
    const avatar = this.avatarOf(host);
    if (avatar) {
      if (!avatar.hasAttribute(this.AVATAR_ATTR)) {
        avatar.setAttribute(this.AVATAR_ATTR, "1");
        avatar.setAttribute("tabindex", "0");
        avatar.setAttribute("role", "button");
      }
      avatar.title = this.t("vn_edit");
      avatar.setAttribute("aria-label", this.t("vn_edit"));
    } else {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "rn-vn-edit";
      edit.textContent = "✎";
      edit.title = this.t("vn_edit");
      edit.setAttribute("aria-label", this.t("vn_edit"));
      edit.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openPanel({ ...this.plain(identity), name: identity.name, idKey: identity.idKey }, edit);
      });
      box.appendChild(edit);
    }

    host.dataset.rnVnKey = identity.idKey;
    host.dataset.rnVnRev = String(this.rev);
  },

  avatarOf: function (host) {
    const avatar = host.querySelector("#author-photo");
    return avatar && avatar.closest(this.hostSelector) === host ? avatar : null;
  },

  releaseAvatar: function (avatar) {
    ["tabindex", "role", "title", "aria-label", this.AVATAR_ATTR].forEach((a) => avatar.removeAttribute(a));
  },

  // 用委派監聽頭像的點擊：YouTube 會把同一個訊息元素重複用給其他觀眾，點下去時才判斷是誰
  bindAvatar: function () {
    if (this.avatarHandler) return;
    this.avatarHandler = (e) => {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      const avatar = e.target && e.target.closest && e.target.closest("[" + this.AVATAR_ATTR + "]");
      if (!avatar) return;
      const host = avatar.closest(this.hostSelector);
      const identity = host && this.identityOf(host);
      if (!identity) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.openPanel({ ...this.plain(identity), name: identity.name, idKey: identity.idKey }, avatar);
    };
    ["click", "keydown"].forEach((type) => document.addEventListener(type, this.avatarHandler, true));
  },

  t: function (key, params) {
    return typeof I18n !== "undefined" ? I18n.t(key, params) : key;
  },

  // ---------------------------------------------------------------- 迷你面板 (最近發言的筆記、評分榜)
  noteRecent: function (identity) {
    const entry = { ...this.plain(identity), name: identity.name, idKey: identity.idKey };
    this.recent = [entry, ...this.recent.filter((r) => r.idKey !== entry.idKey)].slice(0, this.MAX_RECENT);
    this.scheduleDock();
  },

  scheduleDock: function () {
    if (!this.dockOpen || this.dockTimer) return;
    this.dockTimer = setTimeout(() => {
      this.dockTimer = null;
      this.renderDock();
    }, 400);
  },

  setDockOpen: function (open) {
    this.dockOpen = open;
    try {
      chrome.storage.local.get(this.SETTINGS_KEY, (res) => {
        chrome.storage.local.set({ [this.SETTINGS_KEY]: { ...(res[this.SETTINGS_KEY] || {}), dockOpen: open } });
      });
    } catch (e) {
      // 無法保存時只影響下次開啟的預設狀態
    }
    this.renderDock();
  },

  renderDock: async function () {
    if (!this.started) return;
    if (!this.dock) {
      this.dock = document.createElement("div");
      this.dock.id = "rn-vn-dock";
      document.body.appendChild(this.dock);
    }
    const dock = this.dock;
    dock.classList.toggle("rn-vn-dark", document.documentElement.hasAttribute("dark"));
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const toggle = el("button", "rn-vn-dock-toggle", this.dockOpen ? "📋 ▾" : "📋");
    toggle.type = "button";
    toggle.title = this.t("vn_dock_title");
    toggle.setAttribute("aria-label", this.t("vn_dock_title"));
    toggle.setAttribute("aria-expanded", this.dockOpen ? "true" : "false");
    toggle.addEventListener("click", () => this.setDockOpen(!this.dockOpen));
    if (!this.dockOpen) {
      dock.replaceChildren(toggle);
      return;
    }

    const tab = this.dockTab;
    let items = [];
    if (tab === "top") {
      const top = await this.send({ type: "VN_TOP", limit: 10 });
      items = (top || []).map((record) => ({ record, name: "" }));
    } else if (this.recent.length) {
      const recent = this.recent.slice();
      const res = await this.send({ type: "VN_LOOKUP", ids: recent });
      if (res) {
        this.tags = res.tags || this.tags;
        items = recent.map((r, i) => ({ record: res.records[i], name: r.name })).filter((x) => x.record);
      }
    }
    if (!this.dock || !this.dockOpen || tab !== this.dockTab) return;

    const body = el("div", "rn-vn-dock-body");
    const tabs = el("div", "rn-vn-dock-tabs");
    tabs.setAttribute("role", "tablist");
    [
      ["recent", "vn_dock_recent"],
      ["top", "vn_dock_top"],
    ].forEach(([id, key]) => {
      const b = el("button", "", this.t(key));
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", tab === id ? "true" : "false");
      b.addEventListener("click", () => {
        this.dockTab = id;
        this.renderDock();
      });
      tabs.appendChild(b);
    });
    body.appendChild(tabs);

    const defs = new Map(this.tags.map((t) => [t.id, t]));
    items.forEach(({ record, name }, i) => {
      const item = el("div", "rn-vn-dock-item");
      const head = el("div");
      const shown = record.customNickname || name || record.name || (record.ext && record.ext.name) || record.handle || record.channelId;
      head.appendChild(el("span", "rn-vn-dock-name", (tab === "top" ? i + 1 + ". " : "") + shown));
      if (record.score !== 0) {
        head.appendChild(
          this.chip((record.score > 0 ? "+" : "") + record.score, "", "rn-vn-score" + (record.score < 0 ? " rn-vn-neg" : ""))
        );
      }
      record.tagIds.forEach((id) => {
        const def = defs.get(id);
        if (def) head.appendChild(this.chip(def.label, def.color));
      });
      if (record.ext) record.ext.tags.forEach((t) => head.appendChild(this.chip(t.label, t.color, "rn-vn-ext")));
      item.appendChild(head);
      if (tab !== "top") {
        record.notes.forEach((n) => item.appendChild(el("div", "rn-vn-dock-note", "📌 " + n)));
        if (record.ext) record.ext.aiTags.forEach((t) => item.appendChild(el("div", "rn-vn-dock-note", "🤖 " + t)));
      }
      body.appendChild(item);
    });
    if (items.length === 0) {
      body.appendChild(el("div", "rn-vn-dock-empty", this.t(tab === "top" ? "vn_dock_top_empty" : "vn_dock_empty")));
    }
    dock.replaceChildren(body, toggle);
  },

  // ---------------------------------------------------------------- 編輯面板
  closePanel: function () {
    if (this.panel) this.panel.remove();
    this.panel = null;
    this.panelIdentity = null;
  },

  // anchor 為 null 時表示就地重畫 (保留位置)
  openPanel: async function (identity, anchor) {
    const res = await this.send({
      type: "VN_LOOKUP",
      ids: [this.plain(identity)],
    });
    if (!res) return;
    this.tags = res.tags || [];
    const record = res.records[0] || {
      customNickname: "",
      tagIds: [],
      notes: [],
      score: 0,
      ext: null,
      name: "",
    };

    let panel = this.panel;
    const previousFocus = panel && document.activeElement && document.activeElement.dataset.rnVnField;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = this.PANEL_ID;
      panel.setAttribute("role", "dialog");
      // 避免 YouTube 的快捷鍵攔截輸入
      ["keydown", "keyup", "keypress"].forEach((type) =>
        panel.addEventListener(type, (e) => {
          e.stopPropagation();
          if (type === "keydown" && e.key === "Escape") this.closePanel();
        })
      );
      document.body.appendChild(panel);
      this.panel = panel;
      if (!this.outsideBound) {
        this.outsideBound = true;
        document.addEventListener(
          "mousedown",
          (e) => {
            if (this.panel && !this.panel.contains(e.target) && !(e.target.closest && e.target.closest(".rn-vn-edit, [" + this.AVATAR_ATTR + "]"))) {
              this.closePanel();
            }
          },
          true
        );
      }
    }
    this.panelIdentity = identity;
    panel.classList.toggle("rn-vn-dark", document.documentElement.hasAttribute("dark"));
    panel.replaceChildren();

    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const save = (patch) => {
      const body = { ...patch };
      if (identity.name) body.name = identity.name;
      return this.send({
        type: "VN_PATCH",
        identity: this.plain(identity),
        patch: body,
      });
    };

    // 標題
    const head = el("div", "rn-vn-head");
    const titleBox = el("div", "rn-vn-title");
    titleBox.appendChild(el("div", "", identity.name || record.name || identity.handle || identity.channelId));
    titleBox.appendChild(el("div", "rn-vn-sub", [identity.handle, identity.channelId].filter(Boolean).join(" · ")));
    const close = el("button", "", "✕");
    close.type = "button";
    close.setAttribute("aria-label", this.t("vn_close"));
    close.addEventListener("click", () => this.closePanel());
    head.append(titleBox, close);
    panel.appendChild(head);

    // 自訂暱稱
    panel.appendChild(el("h4", "", this.t("vn_nickname")));
    const nick = el("input");
    nick.type = "text";
    nick.maxLength = ViewerModel.LIMITS.NICKNAME;
    nick.value = record.customNickname || "";
    nick.placeholder = this.t("vn_nickname_ph");
    nick.dataset.rnVnField = "nick";
    const commitNick = () => {
      if (nick.value.trim() !== (record.customNickname || "")) save({ customNickname: nick.value });
    };
    nick.addEventListener("change", commitNick);
    nick.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nick.blur();
    });
    panel.appendChild(nick);

    // 評分
    panel.appendChild(el("h4", "", this.t("vn_score")));
    const scoreRow = el("div", "rn-vn-row");
    const minus = el("button", "", "−1");
    const plus = el("button", "", "+1");
    const reset = el("button", "", this.t("vn_score_reset"));
    [minus, plus, reset].forEach((b) => (b.type = "button"));
    minus.addEventListener("click", () => save({ scoreDelta: -1 }));
    plus.addEventListener("click", () => save({ scoreDelta: 1 }));
    reset.addEventListener("click", () => save({ score: 0 }));
    scoreRow.append(minus, el("span", "rn-vn-scoreval", String(record.score || 0)), plus, reset);
    panel.appendChild(scoreRow);

    // 標籤
    panel.appendChild(el("h4", "", this.t("vn_tags")));
    const tagBox = el("div", "rn-vn-tags");
    const active = new Set(record.tagIds);
    this.tags.forEach((def) => {
      const b = el("button", "rn-vn-tag", def.label);
      b.type = "button";
      b.setAttribute("aria-pressed", active.has(def.id) ? "true" : "false");
      if (def.color) {
        b.style.background = def.color;
        b.style.color = this.contrastText(def.color);
      }
      b.addEventListener("click", () => save(active.has(def.id) ? { removeTagId: def.id } : { addTagId: def.id }));
      tagBox.appendChild(b);
    });
    panel.appendChild(tagBox);
    const newRow = el("div", "rn-vn-row");
    newRow.style.marginTop = "6px";
    const newTag = el("input");
    newTag.type = "text";
    newTag.maxLength = ViewerModel.LIMITS.TAG_LABEL;
    newTag.placeholder = this.t("vn_new_tag");
    newTag.dataset.rnVnField = "newtag";
    const color = el("input");
    color.type = "color";
    color.value = "#90caf9";
    color.title = this.t("vn_tag_color");
    const addTag = el("button", "", this.t("vn_add"));
    addTag.type = "button";
    const commitTag = async () => {
      const label = newTag.value.trim();
      if (!label) return;
      let def = this.tags.find((t) => t.label === label);
      if (!def) {
        def = { id: ViewerModel.newTagId(this.tags), label, color: color.value };
        const tags = await this.send({ type: "VN_TAGS_SET", tags: [...this.tags, def] });
        if (!tags) return;
      }
      save({ addTagId: def.id });
    };
    addTag.addEventListener("click", commitTag);
    newTag.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitTag();
    });
    newRow.append(newTag, color, addTag);
    panel.appendChild(newRow);

    // 由附加模組提供的唯讀標籤
    if (record.ext && (record.ext.tags.length || record.ext.aiTags.length)) {
      panel.appendChild(el("h4", "", this.t("vn_ext_tags")));
      const extBox = el("div", "rn-vn-tags");
      record.ext.tags.forEach((t) => extBox.appendChild(this.chip(t.label, t.color, "rn-vn-ext")));
      record.ext.aiTags.forEach((t) => extBox.appendChild(this.chip(t, "", "rn-vn-ext")));
      panel.appendChild(extBox);
    }

    // 備註
    panel.appendChild(el("h4", "", this.t("vn_notes")));
    record.notes.forEach((text) => {
      const row = el("div", "rn-vn-note");
      row.appendChild(el("span", "", "📌 " + text));
      const del = el("button", "", "✕");
      del.type = "button";
      del.setAttribute("aria-label", this.t("vn_delete_note"));
      del.addEventListener("click", () => save({ removeNote: text }));
      row.appendChild(del);
      panel.appendChild(row);
    });
    const note = el("input");
    note.type = "text";
    note.maxLength = ViewerModel.LIMITS.NOTE;
    note.placeholder = this.t("vn_note_ph");
    note.dataset.rnVnField = "note";
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && note.value.trim()) save({ addNote: note.value });
    });
    panel.appendChild(note);

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - pr.width - 8));
      let top = rect.bottom + 6;
      if (top + pr.height > window.innerHeight - 8) top = Math.max(8, rect.top - pr.height - 6);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      nick.focus();
    } else if (previousFocus) {
      const field = panel.querySelector(`[data-rn-vn-field="${previousFocus}"]`);
      if (field) field.focus();
    }
  },
};

if (typeof module !== "undefined" && module.exports) module.exports = { ViewerNotes };
else ViewerNotes.init();
