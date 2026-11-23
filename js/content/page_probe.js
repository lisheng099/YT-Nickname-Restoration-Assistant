// ===========================================================
// page_probe.js - 頻道 ID 探針 (在頁面環境執行)
// 用途：聊天訊息元素的作者頻道 ID (UC...) 只有頁面本身的腳本讀得到，
//       這裡把它寫到元素的 data-rn-cid 屬性，供擴充功能的其他腳本使用。
// 說明：只讀取 YouTube 已經放在元素上的資料，不發出任何網路請求。
// ===========================================================

(function () {
  if (!location.pathname.startsWith("/live_chat")) return;
  if (window.__rnCidProbe) return;
  window.__rnCidProbe = true;

  const HOSTS = [
    "yt-live-chat-text-message-renderer",
    "yt-live-chat-paid-message-renderer",
    "yt-live-chat-paid-sticker-renderer",
    "yt-live-chat-membership-item-renderer",
    "ytd-sponsorships-live-chat-gift-purchase-announcement-renderer",
  ];
  const SELECTOR = HOSTS.join(",");
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

  const readId = (el) => {
    const data = el.data || (el.__data && el.__data.data) || null;
    let id = data && data.authorExternalChannelId;
    // 會員贈禮公告的作者資料在 header 內
    if (!id && data && data.header) {
      const header = data.header.liveChatSponsorshipsHeaderRenderer;
      id = header && header.authorExternalChannelId;
    }
    return typeof id === "string" && CHANNEL_ID.test(id) ? id : "";
  };

  const mark = (el, retry) => {
    const id = readId(el);
    if (id) {
      if (el.getAttribute("data-rn-cid") !== id) el.setAttribute("data-rn-cid", id);
    } else {
      if (el.hasAttribute("data-rn-cid")) el.removeAttribute("data-rn-cid");
      // 元素剛建立時資料可能還沒放上去，稍後再讀一次
      if (retry) setTimeout(() => mark(el, false), 80);
    }
  };

  const scan = (root) => {
    if (root.matches && root.matches(SELECTOR)) mark(root, true);
    if (root.querySelectorAll) root.querySelectorAll(SELECTOR).forEach((el) => mark(el, true));
  };

  const start = () => {
    scan(document.body);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") {
          // YouTube 重複使用元素時會換掉訊息 id
          if (m.target.matches && m.target.matches(SELECTOR)) mark(m.target, true);
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) scan(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["id"] });
  };

  document.addEventListener("sm-probe-cid", () => {
    if (document.body) scan(document.body);
  });

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
