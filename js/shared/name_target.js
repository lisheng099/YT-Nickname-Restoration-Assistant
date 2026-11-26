// ===========================================================
// name_target.js - 聊天室與留言區的「名稱」定位 (兩個擴充功能共用)
// 用途：直播聊天室、一般影片留言區與 Shorts 留言區都只佔用作者名稱：
//       找出訊息 / 留言元素 (host)、作者名稱元素、暱稱還原後的名稱節點、@handle、頻道 ID、
//       會員月份，以及滑鼠事件是否落在名稱上 (留言內文裡的 @提及 與頭像不算)。
// 說明：只讀取頁面上已有的元素與屬性，不發出任何網路請求。
// ===========================================================

(function (root) {
  const CHAT_HOSTS = [
    "yt-live-chat-text-message-renderer",
    "yt-live-chat-paid-message-renderer",
    "yt-live-chat-paid-sticker-renderer",
    "yt-live-chat-membership-item-renderer",
    "ytd-sponsorships-live-chat-gift-purchase-announcement-renderer",
  ];
  // 影片與 Shorts 的留言 (新版 ViewModel 與舊版 renderer)
  const COMMENT_HOSTS = ["ytd-comment-view-model", "ytd-comment-renderer"];
  const DUAL_CLASS = "rn-restored-name";
  // 擴充功能放進「名稱元素裡面」的自訂暱稱等節點 (不是 YouTube 的名稱文字)
  const OWN_ATTR = "data-rn-own";
  // 聊天室 #author-name 裡直接放的原文字 (尚未還原時) 包進這個 span，才能用 CSS 隱藏
  const NATIVE_TEXT_CLASS = "rn-native-text";
  const OWNER_BADGE = "ytd-author-comment-badge-renderer";
  const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
  // 名稱以外、不能當成名稱的區塊 (訊息與留言內文：裡面的 @提及 是別人的名字)
  // (聊天室的 #content 包著名稱，不能列在這裡)
  const BODY_IDS = new Set(["message", "content-text"]);

  const COMMENT_SELECTOR = COMMENT_HOSTS.join(",");

  function isComment(host) {
    return !!(host && host.matches && host.matches(COMMENT_SELECTOR));
  }

  function isHidden(el) {
    if (!el) return true;
    if (el.hidden || (el.closest && el.closest("[hidden]"))) return true;
    return false;
  }

  /**
   * 作者名稱元素：聊天室是 #author-name；留言是連到頻道的 <a id="author-text">，
   * 留言者是頻道主時 YouTube 改用 ytd-author-comment-badge-renderer 顯示名稱。
   */
  function authorOf(host) {
    if (!host || !host.querySelector) return null;
    if (!isComment(host)) return host.querySelector("#author-name");
    const text = host.querySelector("#author-text");
    const badge = host.querySelector(OWNER_BADGE);
    if (badge && !isHidden(badge) && (!text || isHidden(text))) return badge;
    return text || badge || null;
  }

  /**
   * 暱稱還原後的名稱節點 (scanner 以雙節點插入)：在名稱元素裡面 (聊天室是 #author-name 的第一個子元素，
   * 留言在名稱連結內的 <span> 裡)。舊版放在 #author-name 前方，一併認得。
   */
  function restoredOf(host, author) {
    author = author || authorOf(host);
    if (!author) return null;
    if (isComment(host)) return author.querySelector("." + DUAL_CLASS);
    const inside = author.querySelector(":scope > ." + DUAL_CLASS);
    if (inside) return inside;
    const prev = author.previousElementSibling;
    return prev && prev.classList && prev.classList.contains(DUAL_CLASS) ? prev : null;
  }

  /** 名稱元素裡 YouTube 自己的文字 (不含擴充功能放進去的自訂暱稱)。 */
  function nativeTextOf(author) {
    if (!author) return "";
    if (!author.querySelector || !author.querySelector(":scope > [" + OWN_ATTR + "]")) return author.textContent || "";
    let text = "";
    for (const child of author.childNodes) {
      if (child.nodeType === 1 && child.hasAttribute(OWN_ATTR)) continue;
      text += child.textContent || "";
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // 自訂暱稱：放在 YouTube 原本的名稱元素「裡面」(第一個子元素)，用 CSS 隱藏其他子元素。
  // 不可改回「隱藏整個名稱元素、在旁邊另放一份複製樣式的名稱」：
  // 自訂聊天室 CSS (直播畫面、Stylus) 選的是 #author-name / 名稱連結，旁邊的節點選不到；
  // 複製的樣式只是當下的快照，之後才載入的 CSS、陰影、::before / ::after 都不會套上。
  // 詳見 StreamMemo repo 的 extension-shared/README.md「名稱放在原本的名稱元素裡」。
  // ---------------------------------------------------------------------------
  function setCustomName(author, cls, text) {
    if (!author) return null;
    let el = author.querySelector(":scope > ." + cls);
    if (!el) {
      el = document.createElement("span");
      el.className = cls;
      el.setAttribute(OWN_ATTR, "1");
      // 只在新建時放到最前面；之後不搬動，避免與還原名稱互相搶第一個位置
      author.insertBefore(el, author.firstChild);
    }
    if (author.id === "author-name") {
      for (const n of Array.from(author.childNodes)) {
        if (n.nodeType === 3 && n.data.trim()) {
          const wrap = document.createElement("span");
          wrap.className = NATIVE_TEXT_CLASS;
          author.insertBefore(wrap, n);
          wrap.appendChild(n);
        }
      }
    }
    if (el.textContent !== text) el.textContent = text;
    return el;
  }

  function clearCustomName(author, cls) {
    const el = author && author.querySelector && author.querySelector(":scope > ." + cls);
    if (el) el.remove();
  }

  /**
   * 有自訂暱稱時隱藏名稱元素裡的其他文字：原本的名稱、還原後的名稱文字。
   * 保留名稱旁沒有文字的徽章圖示 (#chip-badges) 與還原名稱的訂閱數圓點。
   */
  function customNameCss(attr, cls) {
    const on = "[" + attr + '="1"]';
    const keep = ":not(." + cls + "):not(:has(." + DUAL_CLASS + ")):not(." + DUAL_CLASS + ")";
    return (
      on + " #author-name > " + keep + ":not(#chip-badges)," +
      on + " #author-text > " + keep + "," +
      on + " ytd-author-comment-badge-renderer > " + keep + "," +
      on + " ." + DUAL_CLASS + " > [data-rn-span]{display:none !important}"
    );
  }

  function hrefOf(author) {
    if (!author) return "";
    const link = author.matches && author.matches("a[href]") ? author : author.querySelector && author.querySelector("a[href]");
    return (link && link.getAttribute("href")) || "";
  }

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  /** 原始 @handle (保留大小寫)；找不到時為空字串。 */
  function handleOf(host, author) {
    author = author || authorOf(host);
    if (!author) return "";
    const dual = restoredOf(host, author);
    let handle = (dual && dual.dataset.rnHandle) || author.dataset.rnTargetHandle || author.dataset.rnHandle || "";
    if (!handle && isComment(host)) {
      // scanner 處理的是名稱元素裡的 <span>
      const inner = author.querySelector("[data-rn-target-handle]");
      if (inner) handle = inner.dataset.rnTargetHandle || "";
    }
    if (!handle) {
      const raw = nativeTextOf(author).trim();
      if (/^@[^\s]+$/.test(raw)) handle = raw;
    }
    if (!handle) {
      const m = hrefOf(author).match(/^(?:https?:\/\/(?:www\.)?youtube\.com)?\/(@[^/?#]+)/);
      if (m) handle = decode(m[1]);
    }
    return /^@[^\s]+$/.test(handle) ? handle : "";
  }

  /** 頻道 ID：聊天室由 page_probe 寫在 data-rn-cid；留言沒有 handle 時連結是 /channel/UC...。 */
  function channelIdOf(host, author) {
    const cid = ((host && host.getAttribute && host.getAttribute("data-rn-cid")) || "").trim();
    if (CHANNEL_ID_RE.test(cid)) return cid;
    if (isComment(host)) {
      const m = hrefOf(author || authorOf(host)).match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
      if (m) return m[1];
    }
    return "";
  }

  /** 會員徽章的文字 (YouTube 原生的提示，例如「會員 (6 個月)」)；不是會員時為空字串。 */
  function memberLabel(host) {
    if (!host || !host.querySelectorAll) return "";
    for (const b of host.querySelectorAll("yt-live-chat-author-badge-renderer")) {
      if ((b.getAttribute("type") || "").toLowerCase() !== "member") continue;
      const img = b.querySelector("img");
      const label = (b.getAttribute("aria-label") || (img && img.getAttribute("alt")) || "").trim();
      if (label) return label;
    }
    if (isComment(host)) {
      for (const b of host.querySelectorAll("ytd-sponsor-comment-badge-renderer, #sponsor-comment-badge")) {
        const img = b.querySelector("img");
        const label = (b.getAttribute("aria-label") || (img && (img.getAttribute("alt") || img.getAttribute("aria-label"))) || "").trim();
        if (label) return label;
      }
    }
    return "";
  }

  function isNameNode(node, extraClasses) {
    if (node.id === "author-name" || node.id === "author-text") return true;
    if (node.localName === OWNER_BADGE) return true;
    if (!node.classList) return false;
    if (node.classList.contains(DUAL_CLASS)) return true;
    return (extraClasses || []).some((c) => node.classList.contains(c));
  }

  /**
   * 事件路徑上的名稱元素與所屬的 host；不在名稱上 (頭像、內文、@提及、時間) 時為 null。
   * extraClasses：各擴充功能自己插在名稱旁的元素 (自訂暱稱、標籤列)。
   */
  function findNameTarget(e, hostSelector, extraClasses) {
    let nodes = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!nodes.length) {
      for (let n = e.target; n; n = n.parentNode) nodes.push(n);
    }
    let nameEl = null;
    for (const node of nodes) {
      if (!node || node.nodeType !== 1) continue;
      if (node.matches && node.matches(hostSelector)) {
        if (!nameEl) return null;
        if (!belongsToName(node, nameEl)) return null;
        return { host: node, nameEl };
      }
      if (BODY_IDS.has(node.id)) return null;
      if (!nameEl && isNameNode(node, extraClasses)) nameEl = node;
    }
    return null;
  }

  // 名稱元素是這個 host 自己的作者名稱 (而不是內容裡其他連結)
  function belongsToName(host, nameEl) {
    if (isComment(host)) {
      const header = nameEl.closest("#header-author, #header");
      return !!header && host.contains(header);
    }
    if (nameEl.id === "author-name") return true;
    const parent = nameEl.parentNode;
    if (parent && parent.id === "author-name") return true;
    return !!(parent && parent.querySelector && parent.querySelector(":scope > #author-name"));
  }

  const NameTarget = {
    CHAT_HOSTS,
    COMMENT_HOSTS,
    DUAL_CLASS,
    OWN_ATTR,
    NATIVE_TEXT_CLASS,
    isComment,
    nativeTextOf,
    setCustomName,
    clearCustomName,
    customNameCss,
    authorOf,
    restoredOf,
    handleOf,
    channelIdOf,
    memberLabel,
    findNameTarget,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = NameTarget;
  else root.NameTarget = NameTarget;
})(typeof window !== "undefined" ? window : globalThis);
