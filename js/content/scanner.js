// ===========================================================
// scanner.js - 頁面掃描器 (原 Main.js)
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

    // === [選擇器配置表] (維持不變) ===
    this.targetConfigs = [
      {
        sel: "ytd-pinned-comment-badge-renderer #label",
        mode: this.MODE.EMBEDDED,
      },
      {
        sel: "yt-live-chat-banner-redirect-renderer #banner-text span",
        mode: this.MODE.EMBEDDED,
      },
      {
        sel: "yt-gift-message-view-model #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-banner-poll-renderer #metadata-text",
        mode: this.MODE.WRAPPER,
      },
      {
        sel: "yt-live-chat-poll-header-renderer .metadata",
        mode: this.MODE.WRAPPER,
      },
      {
        sel: "ytd-comment-renderer #author-text span",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "ytd-comment-view-model #author-text span",
        mode: this.MODE.STANDARD,
      },
      { sel: "ytd-comment-view-model h3 > a", mode: this.MODE.STANDARD },
      {
        sel: "ytd-author-comment-badge-renderer #text",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-ticker-paid-message-item-renderer #text",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-ticker-sponsor-item-renderer #text",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-pinned-message-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-text-message-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-paid-message-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-author-chip #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "yt-live-chat-membership-item-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "ytd-sponsorships-live-chat-gift-purchase-announcement-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
        sel: "ytd-sponsorships-live-chat-gift-redemption-announcement-renderer #author-name",
        mode: this.MODE.STANDARD,
      },
      {
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
    // (設定載入邏輯維持不變)
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    const { SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY } =
      window.AppConfig;
    chrome.storage.local.get([SETTINGS_KEY, CLICK_TO_COPY_KEY], (res) => {
      const settings = res[SETTINGS_KEY];
      if (settings && settings.maxLength) {
        this.maxLength = parseInt(settings.maxLength, 10);
      }
      TooltipManager.setCopyEnabled(res[CLICK_TO_COPY_KEY] === true);
      // 速度設定現在由 Background 處理，這裡不需要了
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
    // (Mutation 處理邏輯維持不變)
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
      if (
        el.dataset.rnReplaced === "yes" &&
        el.dataset.rnExpired !== "true" &&
        el.dataset.rnTargetHandle === handle
      ) {
        return;
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

  // === [核心變更]：使用 DataBridge 更新元素 ===
  updateElement(handle, element) {
    if (handle.includes("\n")) handle = handle.split("\n")[0].trim();

    // 標記目標，防止非同步回來後元素已被重複使用
    element.dataset.rnTargetHandle = handle;

    // 呼叫 DataBridge，無論是快取還是網路，統一在這裡回來
    DataBridge.getData(handle, (data) => {
      if (
        data &&
        element.isConnected &&
        element.dataset.rnTargetHandle === handle
      ) {
        this.applyUpdate(element, handle, data);
      }
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
