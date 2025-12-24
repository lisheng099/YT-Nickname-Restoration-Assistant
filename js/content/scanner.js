// ===========================================================
// scanner.js - 頁面掃描器
// 用途：專注於 MutationObserver DOM 監測與 UI 渲染調度。
// ===========================================================

class PageScanner {
  constructor() {
    this.observer = null;
    this.isScanning = false;

    // 批次處理佇列
    this.mutationQueue = new Set();
    this.mutationTimer = null;
    this.BATCH_DELAY = 200;

    this.maxLength = window.AppConfig?.DEFAULT_MAX_LENGTH || 20;

    // === [定義 UI 渲染模式] ===
    this.MODE = {
      STANDARD: "1", // 標準全替換
      WRAPPER: "2", // 投票包裹
      EMBEDDED: "3", // 句中嵌入
    };

    // === [選擇器配置表] ===
    this.targetConfigs = [
      // --- 📌 特殊標籤與橫幅區塊 (特殊渲染模式) ---
      {
        // 留言區的「已置頂」標籤 (顯示於置頂留言上方)
        sel: "ytd-pinned-comment-badge-renderer #label",
        mode: this.MODE.EMBEDDED, // 嵌入模式：直接替換文字內容
      },
      {
        // 直播聊天室頂部的「重新導向」橫幅 (例如：轉移到新直播)
        sel: "yt-live-chat-banner-redirect-renderer #banner-text span",
        mode: this.MODE.EMBEDDED, // 嵌入模式
      },

      // --- 🎁 禮物與贊助相關 (新版介面) ---
      {
        // 禮物訊息或虛擬禮物通知的作者名稱
        sel: "yt-gift-message-view-model #author-name",
        mode: this.MODE.STANDARD, // 標準模式
      },

      // --- 📊 投票活動區塊 (外層包覆模式) ---
      {
        // 直播聊天室的「投票」橫幅文字
        sel: "yt-live-chat-banner-poll-renderer #metadata-text",
        mode: this.MODE.WRAPPER, // 包覆模式：處理較複雜的 DOM 結構
      },
      {
        // 直播聊天室內的「投票」標題區域
        sel: "yt-live-chat-poll-header-renderer .metadata",
        mode: this.MODE.WRAPPER, // 包覆模式
      },

      // --- 💬 一般影片留言區 (標準模式) ---
      {
        // 傳統留言區的作者名稱 (舊版/部分介面)
        sel: "ytd-comment-renderer #author-text span",
        mode: this.MODE.STANDARD,
      },
      {
        // 新版 ViewModel 架構的留言作者名稱 (目前最常見)
        sel: "ytd-comment-view-model #author-text span",
        mode: this.MODE.STANDARD,
      },
      {
        // 新版留言區作者名稱的連結 (作為備用或特定視圖)
        sel: "ytd-comment-view-model h3 > a",
        mode: this.MODE.STANDARD,
      },
      {
        // 留言區作者的特殊徽章文字 (例如：被創作者按愛心)
        sel: "ytd-author-comment-badge-renderer #text",
        mode: this.MODE.STANDARD,
      },

      // --- 🎫 直播聊天室：頂部跑馬燈 (Ticker) ---
      {
        // 頂部跑馬燈：Super Chat (SC) 付費訊息
        sel: "yt-live-chat-ticker-paid-message-item-renderer #text",
        mode: this.MODE.STANDARD,
      },
      {
        // 頂部跑馬燈：會員加入/贊助訊息
        sel: "yt-live-chat-ticker-sponsor-item-renderer #text",
        mode: this.MODE.STANDARD,
      },

      // --- 🔴 直播聊天室：訊息列表內容 ---
      {
        // 聊天室內的「置頂訊息」
        sel: "yt-live-chat-pinned-message-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // 最常見的「一般文字訊息」
        sel: "yt-live-chat-text-message-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // Super Chat (SC) 付費訊息
        sel: "yt-live-chat-paid-message-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // 作者標籤 (通用元件，用於多種聊天室訊息類型)
        sel: "yt-live-chat-author-chip #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // 新會員加入通知 (綠色訊息)
        sel: "yt-live-chat-membership-item-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // 會員贈禮公告：購買者 (送禮的人)
        sel: "ytd-sponsorships-live-chat-gift-purchase-announcement-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // 會員贈禮公告：接收者 (收到禮物的人)
        sel: "ytd-sponsorships-live-chat-gift-redemption-announcement-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        // Q&A 問答功能的發問者名稱
        sel: "yt-live-chat-call-for-questions-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
    ];

    this.masterSelector = this.targetConfigs.map((c) => c.sel).join(",");
    this.init();
  }

  init() {
    if (window === window.top || location.pathname.includes("live_chat")) {
      this.loadConfig();
      this.triggerBurstReset();
      this.startObservation();
      this.setupUrlListener();
    }
  }

  triggerBurstReset() {
    try {
      chrome.runtime.sendMessage({ type: "RESET_BURST_QUOTA" });
      if (typeof Logger !== "undefined") Logger.info("已請求重置加速額度");
    } catch (e) {}
  }

  loadConfig() {
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    const { SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY } =
      window.AppConfig;
    chrome.storage.local.get([SETTINGS_KEY, CLICK_TO_COPY_KEY], (res) => {
      const settings = res[SETTINGS_KEY];
      if (settings && settings.maxLength) {
        this.maxLength = parseInt(settings.maxLength, 10);
      }
      TooltipManager.setCopyEnabled(res[CLICK_TO_COPY_KEY] === true);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue.maxLength) {
          this.maxLength = parseInt(
            changes[SETTINGS_KEY].newValue.maxLength,
            10
          );
        }
        if (changes[CLICK_TO_COPY_KEY]) {
          TooltipManager.setCopyEnabled(
            changes[CLICK_TO_COPY_KEY].newValue === true
          );
        }
      }
    });
  }

  startObservation() {
    if (this.isScanning) return;
    this.isScanning = true;

    if (typeof Logger !== "undefined") {
      Logger.green("PageScanner 已啟動 (DOM 監聽中...)");
    }

    this.scanDeep(document.body);

    this.observer = new MutationObserver((mutations) =>
      this.handleMutations(mutations)
    );
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "id", "class"],
    });
  }

  handleMutations(mutations) {
    let hasUpdates = false;
    for (const m of mutations) {
      if (m.type === "childList" && m.addedNodes.length > 0) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            const tag = node.tagName.toLowerCase();
            if (
              tag.includes("yt-live-chat") ||
              tag.includes("ytd-comment") ||
              tag.includes("ytd-item-section-renderer") ||
              tag.includes("ytd-pinned-comment")
            ) {
              this.mutationQueue.add(node);
              hasUpdates = true;
            } else if (
              node.querySelector &&
              (node.querySelector("ytd-comment-view-model") ||
                node.querySelector("yt-live-chat-text-message-renderer"))
            ) {
              this.mutationQueue.add(node);
              hasUpdates = true;
            }
          }
        });
      } else if (m.type === "attributes") {
        const target = m.target;
        if (target.matches && target.matches(this.masterSelector)) {
          this.mutationQueue.add(target.parentElement || target);
          hasUpdates = true;
        }
      }
    }
    if (hasUpdates) this.scheduleBatchProcess();
  }

  scheduleBatchProcess() {
    if (this.mutationTimer) return;
    this.mutationTimer = setTimeout(() => {
      this.processMutationQueue();
      this.mutationTimer = null;
    }, this.BATCH_DELAY);
  }

  processMutationQueue() {
    if (this.mutationQueue.size === 0) return;
    const nodesToProcess = Array.from(this.mutationQueue);
    this.mutationQueue.clear();
    nodesToProcess.forEach((node) => {
      if (node.isConnected) this.scanDeep(node);
    });
  }

  scanDeep(root) {
    if (!root) return;

    // 處理當前 Root 下的一般元素 (Light DOM)
    if (root.querySelectorAll) {
      const elements = root.querySelectorAll(this.masterSelector);
      elements.forEach((el) => this.processNode(el));
    }

    // 深入掃描 Shadow DOM
    // 如果 root 本身就有 shadowRoot (例如是從外面傳進來的 Custom Element)
    if (root.shadowRoot) {
      this.scanDeep(root.shadowRoot);
    }

    // 找出所有可能包含 Shadow Root 的子孫元素
    if (root.querySelectorAll) {
      const allElements = root.querySelectorAll("*");
      for (let i = 0; i < allElements.length; i++) {
        if (allElements[i].shadowRoot) {
          this.scanDeep(allElements[i].shadowRoot);
        }
      }
    }
  }

  processNode(el) {
    const config = this.targetConfigs.find((c) => el.matches(c.sel));
    if (!config) return;

    const rawText = (el.textContent || "").trim();
    const mode = config.mode;
    el.dataset.rnMode = mode;

    let handle = null;

    if (mode === this.MODE.EMBEDDED) {
      const match = rawText.match(/(@[\w\-\.]+)/);
      if (match) handle = match[1];
    } else if (mode === this.MODE.WRAPPER) {
      const match = rawText.match(/^(@[^ ]+)/);
      if (match) handle = match[1];
    } else {
      if (this.isHandle(rawText)) handle = rawText;
    }

    if (handle) {
      if (handle.length <= 1) return;
      if (el.dataset.rnReplaced === "yes") {
        if (
          el.dataset.rnExpired !== "true" &&
          el.dataset.rnTargetHandle === handle
        ) {
          return;
        }
        if (
          el.dataset.rnFetching === "true" &&
          el.dataset.rnTargetHandle === handle
        ) {
          return;
        }
      }
      this.updateElement(handle, el);
    } else {
      if (mode === this.MODE.STANDARD && !el.dataset.rnReplaced) {
        TooltipManager.attachData(el, null, rawText);
      }
    }
  }

  isHandle(text) {
    return /^@[^\s]+$/.test(text);
  }

// === 使用 DataBridge 更新元素 ===
  updateElement(handle, element) {
    if (handle.includes("\n")) handle = handle.split("\n")[0].trim();

    // 標記目標，防止非同步回來後元素已被重複使用
    element.dataset.rnTargetHandle = handle;
    element.dataset.rnFetching = "true";

    // 呼叫 DataBridge
    DataBridge.getData(handle, (data) => {
      // 1. 基礎檢查：元素是否還在？目標Handle是否沒變？(防止非同步後的錯置)
      if (!element.isConnected || element.dataset.rnTargetHandle !== handle) {
        return;
      }

      // 2. 失敗處理：若 data 為 null，代表抓取失敗
      // 必須移除 Fetching 標記，這樣下次捲動或刷新時才有機會重試
      if (!data) {
        delete element.dataset.rnFetching;
        return;
      }

      // 3. 成功處理：
      // 若資料有效 (未過期)，則移除 Fetching 標記 (視為任務完成)
      // (若資料過期，Fetching 標記保留，因為 DataBridge 還會觸發第二次回調)
      if (!data.isExpired) {
        delete element.dataset.rnFetching;
      }

      // 4. 執行渲染
      this.applyUpdate(element, handle, data);
    });
  }

  applyUpdate(el, handle, data) {
    let displayName = data.name;
    const fullName = data.name;

    const chars = [...displayName];
    if (chars.length > this.maxLength) {
      displayName = chars.slice(0, this.maxLength).join("") + "...";
    }

    const mode = el.dataset.rnMode || this.MODE.STANDARD;

    switch (mode) {
      case this.MODE.EMBEDDED:
        TooltipManager.renderEmbedded(
          el,
          handle,
          displayName,
          fullName,
          data.subs,
          data.isExpired
        );
        break;
      case this.MODE.WRAPPER:
        TooltipManager.renderWrapper(
          el,
          handle,
          displayName,
          fullName,
          data.subs,
          data.isExpired
        );
        break;
      case this.MODE.STANDARD:
      default:
        TooltipManager.renderStandard(
          el,
          handle,
          displayName,
          data.subs,
          data.isExpired
        );
        if (fullName !== displayName) {
          TooltipManager.attachData(
            el,
            handle,
            fullName,
            data.subs,
            data.isExpired
          );
        }
        break;
    }
  }

  setupUrlListener() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        this.triggerBurstReset();
        setTimeout(() => this.scanDeep(document.body), 1500);
      }
    }, 500);
  }
}

new PageScanner();
