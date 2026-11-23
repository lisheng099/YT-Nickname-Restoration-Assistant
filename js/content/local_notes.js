// ===========================================================
// local_notes.js - 觀眾版本機自訂暱稱與備註面板 (100% 本機運作)
// 用途：在 YouTube 聊天室點擊頭像即可為觀眾設定自訂暱稱（直接替換顯示名稱）
//       與備註，資料僅存於本機瀏覽器，不上傳至任何伺服器。
//       可於擴充功能彈出視窗開關（預設開啟）。
// ===========================================================

(function () {
  if (!location.pathname.startsWith("/live_chat") && window !== window.top) return;

  const HOST_SELECTOR = [
    "yt-live-chat-text-message-renderer",
    "yt-live-chat-paid-message-renderer",
    "yt-live-chat-membership-item-renderer",
    "yt-live-chat-paid-sticker-renderer",
  ].join(",");

  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  const STYLE_ID = "sm-local-notes-style";
  const PANEL_ID = "sm-local-notes-panel";
  const NICK_CLASS = "sm-local-nick-name";
  const CUSTOM_ATTR = "data-sm-custom";

  const cache = new Map(); // lookupKey -> record | null
  let isEnabled = true;
  let activePanel = null;
  let pendingHosts = new Set();
  let scanTimer = null;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${CUSTOM_ATTR}="1"] #author-name,
      [${CUSTOM_ATTR}="1"] .rn-restored-name {
        display: none !important;
      }
      .${NICK_CLASS} {
        display: inline-flex;
        align-items: center;
        margin-right: 4px;
        vertical-align: baseline;
      }
      #author-photo[data-sm-editable="1"] {
        cursor: pointer;
      }
      #author-photo[data-sm-has-note="1"] {
        box-shadow: 0 0 0 2px #f59e0b;
        border-radius: 50%;
      }
      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483647;
        width: 280px;
        max-width: calc(100vw - 16px);
        background: #ffffff;
        color: #0f172a;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        box-shadow: 0 12px 28px rgba(15, 23, 42, 0.22);
        padding: 12px;
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
      }
      html[data-theme="dark"] #${PANEL_ID} {
        background: #1e293b;
        color: #f1f5f9;
        border-color: #475569;
      }
      #${PANEL_ID} .sm-ln-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .sm-ln-title {
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${PANEL_ID} .sm-ln-close {
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 15px;
        padding: 0 4px;
      }
      #${PANEL_ID} label {
        display: block;
        font-size: 11px;
        font-weight: 600;
        opacity: 0.8;
        margin: 8px 0 4px;
      }
      #${PANEL_ID} .sm-ln-row {
        display: flex;
        gap: 6px;
      }
      #${PANEL_ID} input[type="text"] {
        flex: 1;
        min-width: 0;
        height: 28px;
        padding: 0 8px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
      }
      html[data-theme="dark"] #${PANEL_ID} input[type="text"] {
        border-color: #475569;
      }
      #${PANEL_ID} button.sm-ln-btn {
        height: 28px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #2563eb;
        background: #2563eb;
        color: #ffffff;
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      #${PANEL_ID} ul.sm-ln-list {
        list-style: none;
        margin: 6px 0 0;
        padding: 0;
        max-height: 140px;
        overflow-y: auto;
      }
      #${PANEL_ID} ul.sm-ln-list li {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 6px;
        padding: 4px 6px;
        margin-top: 4px;
        border-radius: 5px;
        background: rgba(148, 163, 184, 0.14);
        font-size: 12px;
        word-break: break-word;
      }
      #${PANEL_ID} .sm-ln-del {
        border: none;
        background: transparent;
        color: #ef4444;
        cursor: pointer;
        font-size: 13px;
        padding: 0 2px;
        flex-shrink: 0;
      }
      #${PANEL_ID} .sm-ln-empty {
        font-size: 12px;
        opacity: 0.65;
        margin: 4px 0 0;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError || !res) resolve(null);
          else resolve(res);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function extractIdentity(host) {
    const cidRaw = (host.getAttribute("data-rn-cid") || "").trim();
    const channelId = CHANNEL_ID_RE.test(cidRaw) ? cidRaw : null;
    const author = host.querySelector("#author-name");
    const dual = host.querySelector(".rn-restored-name");
    let handle =
      (dual && dual.dataset.rnHandle) ||
      (author && (author.dataset.rnHandle || author.dataset.rnTargetHandle)) ||
      "";
    if (!handle && author) {
      const txt = (author.textContent || "").trim();
      if (txt.startsWith("@") && !/\s/.test(txt)) handle = txt;
    }
    handle = handle && handle.startsWith("@") ? handle.toLowerCase() : null;
    const displayName =
      (dual && dual.dataset.rnName) ||
      (author && author.dataset.rnName) ||
      (author && author.textContent && author.textContent.trim()) ||
      handle ||
      channelId ||
      "";
    const subs = Number((dual && dual.dataset.rnSubs) || (author && author.dataset.rnSubs) || 0) || 0;
    return { channelId, handle, displayName, subs, author };
  }

  function cacheKey(id) {
    return id.channelId || id.handle || "";
  }

  function clearAllUI() {
    closePanel();
    document.querySelectorAll(`[${CUSTOM_ATTR}]`).forEach((host) => {
      host.removeAttribute(CUSTOM_ATTR);
    });
    document.querySelectorAll(`.${NICK_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll("#author-photo[data-sm-editable]").forEach((avatar) => {
      delete avatar.dataset.smEditable;
      delete avatar.dataset.smHasNote;
      avatar.removeAttribute("title");
    });
  }

  function renderHost(host, record) {
    const id = extractIdentity(host);
    const { author } = id;
    if (!author || !author.parentNode) return;

    let nickEl = author.parentNode.querySelector(`:scope > .${NICK_CLASS}`);
    const avatar = host.querySelector("#author-photo");

    if (!isEnabled) {
      host.removeAttribute(CUSTOM_ATTR);
      if (nickEl) nickEl.remove();
      if (avatar) {
        delete avatar.dataset.smEditable;
        delete avatar.dataset.smHasNote;
        avatar.removeAttribute("title");
      }
      return;
    }

    // Custom nickname replaces the displayed author name while preserving native color/style
    const nick = record && record.customNickname ? record.customNickname : "";
    if (nick) {
      if (!nickEl) {
        nickEl = document.createElement("span");
        nickEl.className = NICK_CLASS;
        author.insertAdjacentElement("afterend", nickEl);
      }
      nickEl.textContent = nick;
      if (typeof TooltipManager !== "undefined") {
        TooltipManager.copyNativeStyle(author, nickEl);
        const orig = id.displayName && id.displayName !== nick ? id.displayName : "";
        TooltipManager.attachData(
          nickEl,
          id.handle || "",
          orig ? `${nick} (${orig})` : nick,
          id.subs,
          false
        );
      } else {
        nickEl.title = id.displayName ? `${nick} (${id.displayName})` : nick;
      }
      host.setAttribute(CUSTOM_ATTR, "1");
    } else {
      host.removeAttribute(CUSTOM_ATTR);
      if (nickEl) nickEl.remove();
    }

    // Avatar click target & note preview tooltip
    if (avatar) {
      const notes = record && Array.isArray(record.notes) ? record.notes : [];
      avatar.dataset.smEditable = "1";
      avatar.dataset.smHasNote = notes.length > 0 ? "1" : "0";
      avatar.title =
        notes.length > 0
          ? `${I18n.t("local_notes_title") || "備註"}：\n${notes.join("\n")}`
          : I18n.t("local_edit_hint") || "設定自訂暱稱與備註";
    }
  }

  function closePanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
  }

  async function openPanel(host, anchorEl) {
    if (!isEnabled) return;
    ensureStyles();
    closePanel();
    const id = extractIdentity(host);
    const key = cacheKey(id);
    if (!key) return;

    const lookupRes = await send({
      type: "NOTES_LOOKUP",
      ids: [{ channelId: id.channelId, handle: id.handle }],
    });
    let record = (lookupRes && lookupRes.records && lookupRes.records[0]) || cache.get(key) || null;
    cache.set(key, record);

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");

    const head = document.createElement("div");
    head.className = "sm-ln-head";
    const title = document.createElement("span");
    title.className = "sm-ln-title";
    title.textContent = id.displayName || key;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sm-ln-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", closePanel);
    head.append(title, closeBtn);

    const nickLabel = document.createElement("label");
    nickLabel.textContent = I18n.t("local_custom_nickname") || "自訂暱稱";
    const nickRow = document.createElement("div");
    nickRow.className = "sm-ln-row";
    const nickInput = document.createElement("input");
    nickInput.type = "text";
    nickInput.maxLength = 50;
    nickInput.value = (record && record.customNickname) || "";
    nickInput.placeholder = I18n.t("local_nick_placeholder") || "輸入自訂暱稱（留空清除）";
    const nickSave = document.createElement("button");
    nickSave.type = "button";
    nickSave.className = "sm-ln-btn";
    nickSave.textContent = I18n.t("popup_save") || "儲存";
    nickRow.append(nickInput, nickSave);

    const notesLabel = document.createElement("label");
    notesLabel.textContent = I18n.t("local_notes_title") || "備註";
    const noteRow = document.createElement("div");
    noteRow.className = "sm-ln-row";
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.maxLength = 300;
    noteInput.placeholder = I18n.t("local_note_placeholder") || "新增一則本機備註…";
    const noteAdd = document.createElement("button");
    noteAdd.type = "button";
    noteAdd.className = "sm-ln-btn";
    noteAdd.textContent = "+";
    noteRow.append(noteInput, noteAdd);

    const listEl = document.createElement("ul");
    listEl.className = "sm-ln-list";

    const renderList = () => {
      listEl.replaceChildren();
      const notes = record && Array.isArray(record.notes) ? record.notes : [];
      if (notes.length === 0) {
        const empty = document.createElement("p");
        empty.className = "sm-ln-empty";
        empty.textContent = I18n.t("local_notes_empty") || "尚無備註";
        listEl.appendChild(empty);
        return;
      }
      for (const note of notes) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.textContent = note;
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sm-ln-del";
        del.textContent = "×";
        del.addEventListener("click", async () => {
          const out = await send({
            type: "NOTES_SAVE",
            identity: { channelId: id.channelId, handle: id.handle },
            patch: { removeNote: note },
          });
          record = out ? out.record : null;
          cache.set(key, record);
          renderList();
          refreshMatchingHosts(key, record);
        });
        li.append(span, del);
        listEl.appendChild(li);
      }
    };

    const saveNick = async () => {
      const out = await send({
        type: "NOTES_SAVE",
        identity: { channelId: id.channelId, handle: id.handle },
        patch: { customNickname: nickInput.value },
      });
      record = out ? out.record : null;
      cache.set(key, record);
      refreshMatchingHosts(key, record);
    };

    const addNote = async () => {
      const text = noteInput.value.trim();
      if (!text) return;
      const out = await send({
        type: "NOTES_SAVE",
        identity: { channelId: id.channelId, handle: id.handle },
        patch: { addNote: text },
      });
      noteInput.value = "";
      record = out ? out.record : null;
      cache.set(key, record);
      renderList();
      refreshMatchingHosts(key, record);
    };

    nickSave.addEventListener("click", saveNick);
    nickInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveNick();
      }
    });
    noteAdd.addEventListener("click", addNote);
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addNote();
      }
    });

    renderList();
    panel.append(head, nickLabel, nickRow, notesLabel, noteRow, listEl);
    document.body.appendChild(panel);
    activePanel = panel;

    const rect = (anchorEl || host).getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const top = Math.min(window.innerHeight - panelRect.height - 8, Math.max(8, rect.bottom + 6));
    const left = Math.min(window.innerWidth - panelRect.width - 8, Math.max(8, rect.left));
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    nickInput.focus();
  }

  function refreshMatchingHosts(key, record) {
    document.querySelectorAll(HOST_SELECTOR).forEach((h) => {
      if (cacheKey(extractIdentity(h)) === key) renderHost(h, record);
    });
  }

  async function flushHosts() {
    scanTimer = null;
    if (!isEnabled) {
      pendingHosts = new Set();
      return;
    }
    const hosts = Array.from(pendingHosts).filter((h) => h.isConnected);
    pendingHosts = new Set();
    if (hosts.length === 0) return;

    const toFetch = [];
    const seenKeys = new Set();
    const hostEntries = [];
    for (const host of hosts) {
      const id = extractIdentity(host);
      const key = cacheKey(id);
      if (!key) continue;
      hostEntries.push({ host, id, key });
      if (!cache.has(key) && !seenKeys.has(key)) {
        seenKeys.add(key);
        toFetch.push({ key, channelId: id.channelId, handle: id.handle });
      }
    }

    if (toFetch.length > 0) {
      const res = await send({
        type: "NOTES_LOOKUP",
        ids: toFetch.map((x) => ({ channelId: x.channelId, handle: x.handle })),
      });
      const records = res && Array.isArray(res.records) ? res.records : [];
      toFetch.forEach((item, idx) => {
        cache.set(item.key, records[idx] || null);
      });
    }

    if (!isEnabled) return;
    for (const { host, key } of hostEntries) {
      if (host.isConnected) renderHost(host, cache.get(key) || null);
    }
  }

  function queueHost(host) {
    if (!isEnabled) return;
    if (!host || !host.matches || !host.matches(HOST_SELECTOR)) return;
    pendingHosts.add(host);
    if (!scanTimer) scanTimer = setTimeout(flushHosts, 80);
  }

  function scanAll() {
    if (!isEnabled) return;
    document.querySelectorAll(HOST_SELECTOR).forEach(queueHost);
  }

  function init() {
    if (!location.pathname.startsWith("/live_chat")) return;
    ensureStyles();

    const localNotesKey = (window.AppConfig && window.AppConfig.LOCAL_NOTES_KEY) || "yt_realname_local_notes";
    const notesRevKey = (window.AppConfig && window.AppConfig.NOTES_REV_KEY) || "sm_viewer_notes_rev";

    document.addEventListener("click", (e) => {
      if (activePanel && !activePanel.contains(e.target)) {
        const isAvatar = e.target.closest && e.target.closest("#author-photo");
        if (!isAvatar) closePanel();
      }
      if (!isEnabled) return;
      const avatar = e.target.closest && e.target.closest("#author-photo");
      if (avatar) {
        const host = avatar.closest(HOST_SELECTOR);
        if (host) {
          e.preventDefault();
          e.stopPropagation();
          openPanel(host, avatar);
        }
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePanel();
    });

    const observer = new MutationObserver((mutations) => {
      if (!isEnabled) return;
      for (const m of mutations) {
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            if (n.matches && n.matches(HOST_SELECTOR)) queueHost(n);
            else if (n.querySelectorAll) n.querySelectorAll(HOST_SELECTOR).forEach(queueHost);
          });
        } else if (m.type === "attributes" && m.attributeName === "data-rn-cid") {
          queueHost(m.target);
        }
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-rn-cid"],
    });

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[localNotesKey]) {
          isEnabled = changes[localNotesKey].newValue !== false;
          if (!isEnabled) {
            clearAllUI();
          } else {
            scanAll();
          }
        }
        if (changes[notesRevKey]) {
          cache.clear();
          if (isEnabled) scanAll();
        }
      });
    }

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(localNotesKey, (res) => {
        isEnabled = !res || res[localNotesKey] !== false;
        if (isEnabled) scanAll();
      });
    } else {
      scanAll();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
