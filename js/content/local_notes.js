// ===========================================================
// local_notes.js - 觀眾版本機自訂暱稱與備註面板 (100% 本機運作)
// 用途：在 YouTube 聊天室、影片留言區與 Shorts 留言區只佔用「名稱」：滑鼠移到名稱顯示原名稱、訂閱數、會員月份與備註，
//       點擊名稱開啟自訂暱稱（直接替換顯示名稱）與備註的編輯視窗；頭像維持 YouTube 原本的行為。
//       資料僅存於本機瀏覽器，不上傳至任何伺服器。可於擴充功能彈出視窗開關（預設開啟）。
// ===========================================================

(function () {
  if (!location.pathname.startsWith("/live_chat") && window !== window.top) return;

  // 聊天訊息與留言 (影片、Shorts) 都適用，名稱的定位規則在 js/shared/name_target.js
  const HOST_SELECTOR = [...NameTarget.CHAT_HOSTS, ...NameTarget.COMMENT_HOSTS].join(",");
  const STYLE_ID = "sm-local-notes-style";
  const PANEL_ID = "sm-local-notes-panel";
  const NICK_CLASS = "sm-local-nick-name";
  const CUSTOM_ATTR = "data-sm-custom";
  const EDITABLE_ATTR = "data-sm-editable";
  const NOTE_MARK_CLASS = "sm-local-note-mark";
  const DUAL_CLASS = "rn-restored-name";
  // 編輯視窗第一次出現時在底部說明「之後在哪裡開啟 / 關閉」，看過一次就不再顯示
  const INTRO_SEEN_KEY = "sm_viewer_notes_intro_seen";

  const cache = new Map(); // lookupKey -> record | null
  let isEnabled = true;
  let activePanel = null;
  let pendingHosts = new Set();
  let scanTimer = null;
  let introSeen = true; // 讀到 storage 之前先當作看過，避免重複顯示

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${CUSTOM_ATTR}="1"] #author-name,
      [${CUSTOM_ATTR}="1"] .rn-restored-name,
      [${CUSTOM_ATTR}="1"] #author-text,
      [${CUSTOM_ATTR}="1"] ytd-author-comment-badge-renderer {
        display: none !important;
      }
      .${NICK_CLASS} {
        display: inline-flex;
        align-items: center;
        margin-right: 4px;
        vertical-align: baseline;
      }
      [${EDITABLE_ATTR}="1"] #author-name,
      [${EDITABLE_ATTR}="1"] #author-text,
      [${EDITABLE_ATTR}="1"] .${DUAL_CLASS},
      [${EDITABLE_ATTR}="1"] .${NICK_CLASS} {
        cursor: pointer;
      }
      [${EDITABLE_ATTR}="1"] #author-name:hover,
      [${EDITABLE_ATTR}="1"] #author-text:hover,
      [${EDITABLE_ATTR}="1"] .${DUAL_CLASS}:hover,
      [${EDITABLE_ATTR}="1"] .${NICK_CLASS}:hover {
        text-decoration: underline dotted;
        text-underline-offset: 2px;
      }
      .${NOTE_MARK_CLASS} {
        display: inline-block;
        margin: 0 4px 0 2px;
        font-size: 10px;
        line-height: 1;
        opacity: 0.85;
        vertical-align: middle;
        pointer-events: none;
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
      #${PANEL_ID} .sm-ln-tools {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
      }
      #${PANEL_ID} .sm-ln-icon {
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 13px;
        padding: 0 4px;
        opacity: 0.75;
      }
      #${PANEL_ID} .sm-ln-icon:hover {
        opacity: 1;
      }
      #${PANEL_ID} .sm-ln-intro {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px dashed rgba(148, 163, 184, 0.5);
        font-size: 11.5px;
        line-height: 1.5;
      }
      #${PANEL_ID} .sm-ln-intro p {
        margin: 0 0 8px;
        opacity: 0.85;
      }
      #${PANEL_ID} .sm-ln-intro-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
      #${PANEL_ID} button.sm-ln-btn-ghost {
        height: 26px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid #cbd5e1;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
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
    const author = NameTarget.authorOf(host);
    const dual = NameTarget.restoredOf(host, author);
    const channelId = NameTarget.channelIdOf(host, author) || null;
    const rawHandle = NameTarget.handleOf(host, author);
    const handle = rawHandle ? rawHandle.toLowerCase() : null;
    // 留言的名稱元素裡同時有還原後的名稱與隱藏的原文字，有還原節點時不讀整段文字
    const displayName =
      (dual && dual.dataset.rnName) ||
      (author && author.dataset.rnName) ||
      (author && !dual ? (author.textContent || "").trim() : "") ||
      handle ||
      channelId ||
      "";
    const subs = Number((dual && dual.dataset.rnSubs) || (author && author.dataset.rnSubs) || 0) || 0;
    const isExpired = !!((dual && dual.dataset.rnExpired === "true") || (author && author.dataset.rnExpired === "true"));
    return { channelId, handle, rawHandle, displayName, subs, isExpired, author };
  }

  /**
   * 事件路徑上的「名稱」元素 (原生名稱、還原後的名稱、自訂暱稱) 與所屬的聊天訊息或留言；
   * 留言內文裡的 @提及 與頭像不算，避免點到別人的名字卻開啟留言者的視窗。
   */
  function findNameTarget(e) {
    return NameTarget.findNameTarget(e, HOST_SELECTOR, [NICK_CLASS]);
  }

  function cacheKey(id) {
    return id.channelId || id.handle || "";
  }

  function clearAllUI() {
    closePanel();
    document.querySelectorAll(`[${CUSTOM_ATTR}]`).forEach((host) => {
      host.removeAttribute(CUSTOM_ATTR);
    });
    document.querySelectorAll(`[${EDITABLE_ATTR}]`).forEach((host) => {
      host.removeAttribute(EDITABLE_ATTR);
    });
    document.querySelectorAll(`.${NICK_CLASS}, .${NOTE_MARK_CLASS}`).forEach((el) => el.remove());
  }

  function renderHost(host, record) {
    const id = extractIdentity(host);
    const { author } = id;
    if (!author || !author.parentNode) return;

    let nickEl = author.parentNode.querySelector(`:scope > .${NICK_CLASS}`);
    let markEl = author.parentNode.querySelector(`:scope > .${NOTE_MARK_CLASS}`);

    if (!isEnabled) {
      host.removeAttribute(CUSTOM_ATTR);
      host.removeAttribute(EDITABLE_ATTR);
      if (nickEl) nickEl.remove();
      if (markEl) markEl.remove();
      return;
    }

    // 只佔用名稱：名稱可點擊開啟編輯視窗，滑鼠移上顯示資訊 (見 hoverInfo)
    host.setAttribute(EDITABLE_ATTR, "1");

    // Custom nickname replaces the displayed author name while preserving native color/style
    const nick = record && record.customNickname ? record.customNickname : "";
    if (nick) {
      if (!nickEl) {
        nickEl = document.createElement("span");
        nickEl.className = NICK_CLASS;
        author.insertAdjacentElement("afterend", nickEl);
      }
      nickEl.textContent = nick;
      if (typeof TooltipManager !== "undefined") TooltipManager.copyNativeStyle(author, nickEl);
      host.setAttribute(CUSTOM_ATTR, "1");
    } else {
      host.removeAttribute(CUSTOM_ATTR);
      if (nickEl) nickEl.remove();
      nickEl = null;
    }

    // 有備註時在名稱後方放一個小記號 (不佔用頭像)
    const notes = record && Array.isArray(record.notes) ? record.notes : [];
    if (notes.length > 0) {
      if (!markEl) {
        markEl = document.createElement("span");
        markEl.className = NOTE_MARK_CLASS;
        markEl.textContent = "📝";
        markEl.setAttribute("aria-hidden", "true");
      }
      (nickEl || author).insertAdjacentElement("afterend", markEl);
    } else if (markEl) {
      markEl.remove();
    }
  }

  /** 滑鼠移到名稱上時的提示內容：原名稱、handle、訂閱數、會員月份、備註。 */
  // 自訂暱稱與備註關閉時仍顯示原名稱、訂閱數與會員月份，只是不帶暱稱、備註與操作提示
  function hoverInfo(e) {
    const target = findNameTarget(e);
    if (!target) return null;
    const id = extractIdentity(target.host);
    const key = cacheKey(id);
    const record = isEnabled && key ? cache.get(key) || null : null;
    const nick = record && record.customNickname ? record.customNickname : "";
    const original = id.displayName && id.displayName !== id.handle ? id.displayName : "";
    return {
      name: nick || original || id.handle || id.channelId || "",
      original: nick && original && original !== nick ? original : "",
      handle: id.rawHandle || id.handle || "",
      subs: id.subs,
      isExpired: id.isExpired,
      member: NameTarget.memberLabel(target.host),
      notes: record && Array.isArray(record.notes) ? record.notes : [],
      hint: isEnabled && key ? I18n.t("local_click_name_hint") : "",
    };
  }

  function channelUrl(id) {
    if (id.handle) return `https://www.youtube.com/${id.rawHandle || id.handle}`;
    if (id.channelId) return `https://www.youtube.com/channel/${id.channelId}`;
    return "";
  }

  function markIntroSeen() {
    introSeen = true;
    try {
      chrome.storage.local.set({ [INTRO_SEEN_KEY]: Date.now() });
    } catch {
      // storage 無法使用時只在這次頁面內記得
    }
  }

  function setFeatureEnabled(on) {
    const localNotesKey = (window.AppConfig && window.AppConfig.LOCAL_NOTES_KEY) || "yt_realname_local_notes";
    try {
      chrome.storage.local.set({ [localNotesKey]: on });
    } catch {
      // ignore
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
    let id = extractIdentity(host);
    let key = cacheKey(id);
    if (!key) {
      document.dispatchEvent(new CustomEvent("sm-probe-cid"));
      id = extractIdentity(host);
      key = cacheKey(id);
    }
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
    const tools = document.createElement("span");
    tools.className = "sm-ln-tools";
    const url = channelUrl(id);
    if (url) {
      // 聊天室的名稱改成開啟這個視窗，「點擊複製連結」改由這裡提供
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "sm-ln-icon sm-ln-copy";
      copyBtn.textContent = "🔗";
      copyBtn.title = I18n.t("copy_link") || "複製頻道連結";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(url);
          if (typeof TooltipManager !== "undefined") TooltipManager.showToast(I18n.t("copied"));
        } catch {
          // clipboard 被拒絕時不做事
        }
      });
      tools.appendChild(copyBtn);
      // 留言區的名稱也改成開啟這個視窗，要前往頻道頁由這裡開新分頁
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "sm-ln-icon sm-ln-open";
      openBtn.textContent = "↗";
      openBtn.title = I18n.t("open_channel") || "前往頻道";
      openBtn.addEventListener("click", () => {
        window.open(url, "_blank", "noopener");
      });
      tools.appendChild(openBtn);
    }
    const managerBtn = document.createElement("button");
    managerBtn.type = "button";
    managerBtn.className = "sm-ln-icon sm-ln-manager";
    managerBtn.textContent = "📋";
    managerBtn.title = I18n.t("local_open_manager") || "在觀眾資料頁查看";
    managerBtn.addEventListener("click", () => {
      send({ type: "OPEN_MANAGER", query: id.handle || id.channelId || "" });
    });
    tools.appendChild(managerBtn);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sm-ln-close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", I18n.t("notes_close") || "關閉");
    closeBtn.addEventListener("click", closePanel);
    tools.appendChild(closeBtn);
    head.append(title, tools);

    const nickLabel = document.createElement("label");
    nickLabel.textContent = I18n.t("local_custom_nickname") || "自訂暱稱";
    const nickRow = document.createElement("div");
    nickRow.className = "sm-ln-row";
    const nickInput = document.createElement("input");
    nickInput.type = "text";
    nickInput.maxLength = NotesCore.LIMITS.NICKNAME;
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
    noteInput.maxLength = NotesCore.LIMITS.NOTE;
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

    // 第一次開啟：底部說明之後在哪裡開啟 / 關閉，並提供關閉按鈕；看過就記錄下來
    if (!introSeen) {
      const intro = document.createElement("div");
      intro.className = "sm-ln-intro";
      const text = document.createElement("p");
      text.textContent = I18n.t("local_intro_text");
      const actions = document.createElement("div");
      actions.className = "sm-ln-intro-actions";
      const disableBtn = document.createElement("button");
      disableBtn.type = "button";
      disableBtn.className = "sm-ln-btn-ghost sm-ln-disable";
      disableBtn.textContent = I18n.t("local_intro_disable") || "關閉此功能";
      disableBtn.addEventListener("click", () => {
        closePanel();
        setFeatureEnabled(false);
      });
      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "sm-ln-btn sm-ln-intro-close";
      okBtn.textContent = I18n.t("notes_close") || "關閉";
      okBtn.addEventListener("click", closePanel);
      actions.append(disableBtn, okBtn);
      intro.append(text, actions);
      panel.appendChild(intro);
      markIntroSeen();
    }

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
    ensureStyles();

    const localNotesKey = (window.AppConfig && window.AppConfig.LOCAL_NOTES_KEY) || "yt_realname_local_notes";
    const notesRevKey = (window.AppConfig && window.AppConfig.NOTES_REV_KEY) || "sm_viewer_notes_rev";

    // 點擊名稱開啟編輯視窗 (捕獲階段，先於 YouTube 與「點擊複製連結」處理)；頭像不再攔截
    function handleNameClick(e) {
      if (activePanel && e.target && !activePanel.contains(e.target)) {
        const t = findNameTarget(e);
        if (!t) closePanel();
      }
      if (!isEnabled) return;
      const target = findNameTarget(e);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      if (typeof TooltipManager !== "undefined") TooltipManager.hide();
      openPanel(target.host, target.nameEl);
    }

    document.addEventListener("click", handleNameClick, true);
    if (typeof TooltipManager !== "undefined") TooltipManager.addHoverProvider(hoverInfo);

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
        } else if (m.type === "attributes" && m.target.id === "author-text") {
          // YouTube 把同一則留言元素換給另一位留言者時會改寫名稱連結
          const host = m.target.closest && m.target.closest(HOST_SELECTOR);
          if (host) queueHost(host);
        }
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-rn-cid", "href"],
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
      chrome.storage.local.get([localNotesKey, INTRO_SEEN_KEY], (res) => {
        isEnabled = !res || res[localNotesKey] !== false;
        introSeen = !!(res && res[INTRO_SEEN_KEY]);
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
