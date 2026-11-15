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
    this.BATCH_DELAY = 50;
    
    // 前端保險絲狀態
    this.fuseFrontendStatus = "NORMAL";
    this.frontendErrorCount = 0; // 前端 DOM 操作錯誤計數

    this.maxLength = window.AppConfig?.DEFAULT_MAX_LENGTH || 20;

    // 雙節點替換 (預設開啟)：保留 YouTube 原生節點並隱藏，另插入獨立的暱稱節點
    this.dualNode = true;

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
      {
        // 直播聊天室付費貼圖 (Super Stickers)
        sel: "yt-live-chat-paid-sticker-renderer #author-name",
        mode: this.MODE.STANDARD,
      },

      // --- @提及連結 (留言與聊天內文中指向 /@handle 的連結) ---
      // mention: 只有文字剛好是 @handle 時才替換，其他連結 (頻道名稱等) 一律不動
      {
        sel: 'yt-attributed-string a[href^="/@"]',
        mode: this.MODE.STANDARD,
        mention: true,
      },
      {
        sel: 'yt-formatted-string a[href^="/@"]',
        mode: this.MODE.STANDARD,
        mention: true,
      },
    ];

    this.masterSelector = this.targetConfigs.map((c) => c.sel).join(",");
    this.init();
  }

  init() {
    if (window === window.top || location.pathname.includes("live_chat")) {
      I18n.init().then(() => {
        // 改為非同步等待設定載入完成
        this.loadConfig().then(() => {
          this.triggerBurstReset();
          // 確保在設定載入完成後，且保險絲正常才啟動
          if (this.fuseFrontendStatus === "NORMAL") {
            this.startObservation();
          } else {
            if (typeof Logger !== "undefined") Logger.info("[Scanner] 初始化時偵測到前端保險絲熔斷，跳過掃描。");
          }
          this.setupUrlListener();
        });
      });
    }
  }

  triggerBurstReset() {
    try {
      chrome.runtime.sendMessage({ type: "RESET_BURST_QUOTA" });
      if (typeof Logger !== "undefined") Logger.info("已請求重置加速額度");
    } catch (e) {}
  }

  loadConfig() {
    return new Promise((resolve) => {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
         resolve();
         return;
      }
      const { SETTINGS_KEY, CLICK_TO_COPY_KEY, FUSE_FE_KEY } = window.AppConfig;

      chrome.storage.local.get(
        [SETTINGS_KEY, CLICK_TO_COPY_KEY, FUSE_FE_KEY],
        (res) => {
          // 載入基本設定
          const settings = res[SETTINGS_KEY];
          if (settings && settings.maxLength) {
            this.maxLength = parseInt(settings.maxLength, 10);
          }
          this.dualNode = !(settings && settings.dualNode === false);
          TooltipManager.setCopyEnabled(res[CLICK_TO_COPY_KEY] === true);

          // 載入前端保險絲狀態
          if (res[FUSE_FE_KEY]) {
            this.fuseFrontendStatus = res[FUSE_FE_KEY].status;
          }
          
          resolve(); // 完成載入
        }
      );

      // 監聽器只需綁定一次，不影響初始化 Promise
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local") {
          const newSettings = changes[SETTINGS_KEY]?.newValue;
          if (newSettings && newSettings.maxLength) {
            this.maxLength = parseInt(newSettings.maxLength, 10);
          }
          if (changes[SETTINGS_KEY]) {
            this.dualNode = !(newSettings && newSettings.dualNode === false);
          }
          if (changes[CLICK_TO_COPY_KEY]) {
            TooltipManager.setCopyEnabled(
              changes[CLICK_TO_COPY_KEY].newValue === true
            );
          }
          // [新增] 監聽前端保險絲變化
          if (changes[FUSE_FE_KEY]) {
            this.fuseFrontendStatus =
              changes[FUSE_FE_KEY].newValue?.status || "NORMAL";
            this.checkFuseState();
          }
        }
      });
    });
  }

  // 檢查並執行前端保險絲動作
  checkFuseState() {
    if (this.fuseFrontendStatus === "TRIPPED") {
      this.stopObservation();
      if (typeof Logger !== "undefined")
        Logger.red("[Scanner] 前端保險絲已熔斷，停止 UI 渲染。");
    } else {
      // 重置錯誤計數並重啟
      this.frontendErrorCount = 0;
      this.startObservation();
    }
  }

  startObservation() {
    // 檢查前端保險絲
    if (this.isScanning || this.fuseFrontendStatus === "TRIPPED") return;
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

  stopObservation() {
    if (!this.isScanning) return;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.isScanning = false;
    // 清空佇列以防殘留任務
    this.mutationQueue.clear();
  }

  handleMutations(mutations) {
    if (this.fuseFrontendStatus === "TRIPPED") return;

    let hasUpdates = false;
    for (const m of mutations) {
      // 目標元素的文字被 YouTube 直接改寫 (同一個元素換成另一位使用者)
      if (
        m.type === "childList" &&
        m.target.nodeType === 1 &&
        m.target.matches(this.masterSelector)
      ) {
        this.mutationQueue.add(m.target);
        hasUpdates = true;
      }
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
            } else if (
              // 其餘節點改以 targetConfigs 的選擇器判斷，新增的目標區塊不需要再改白名單
              node.matches(this.masterSelector) ||
              node.querySelector(this.masterSelector)
            ) {
              this.mutationQueue.add(node);
              hasUpdates = true;
            }
          }
        });
      } else if (m.type === "attributes") {
        const target = m.target;
        if (target.matches && target.matches(this.masterSelector)) {
          this.mutationQueue.add(target);
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
    // 如果保險絲已經熔斷，就不處理佇列
    if (this.fuseFrontendStatus === "TRIPPED") {
        this.mutationQueue.clear();
        return;
    }

    if (this.mutationQueue.size === 0) return;
    const queued = this.mutationQueue;
    this.mutationQueue = new Set();
    queued.forEach((node) => {
      if (!node.isConnected) return;
      // 祖先節點也在同一批時，掃描祖先就會涵蓋這個節點
      if (this.hasQueuedAncestor(node, queued)) return;
      this.scanDeep(node);
    });
  }

  hasQueuedAncestor(node, queued) {
    let parent = node.parentNode;
    while (parent) {
      if (queued.has(parent)) return true;
      parent = parent.parentNode;
    }
    return false;
  }

  scanDeep(root) {
    // 深層掃描也檢查保險絲，因為 scanDeep 可能被非同步呼叫
    if (!root || this.fuseFrontendStatus === "TRIPPED") return;

    // Root 本身就是目標元素 (例如屬性變動時直接加入佇列的節點)
    if (root.matches && root.matches(this.masterSelector)) {
      this.processNode(root);
    }

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

    // 找出包含 Shadow Root 的子孫元素
    // 只有自訂元素 (標籤名稱含 "-") 會掛載 Shadow Root，逐一走訪並略過其他元素，
    // 不必為每一批變動建立完整的節點清單
    if (root.firstElementChild) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        if (node.shadowRoot && node.localName.includes("-")) {
          this.scanDeep(node.shadowRoot);
        }
        node = walker.nextNode();
      }
    }
  }

  processNode(el) {
    // 如果前端保險絲熔斷，直接不處理任何節點
    if (this.fuseFrontendStatus === "TRIPPED") return;

    try {
        const config = this.targetConfigs.find((c) => el.matches(c.sel));
        if (!config) return;

        const rawText = (el.textContent || "").trim();
        const mode = config.mode;
        el.dataset.rnMode = mode;
        if (config.mention) el.dataset.rnMention = "1";

        let handle = null;

        if (mode === this.MODE.EMBEDDED) {
          // handle 可包含各國文字，以 Unicode 字母與數字比對
          const match = rawText.match(/(@[\p{L}\p{N}_\-.·]+)/u);
          if (match) handle = match[1];
        } else if (mode === this.MODE.WRAPPER) {
          const match = rawText.match(/^(@[^ ]+)/);
          if (match) handle = match[1];
        } else {
          if (this.isHandle(rawText)) {
            handle = rawText;
            // 文字被截斷 (結尾是省略號) 時，改用連結 href 的完整 handle
            if (!config.mention && /(?:…|\.\.\.)$/.test(rawText)) {
              handle = this.handleFromHref(el, rawText) || rawText;
            }
          } else if (!config.mention) {
            handle = this.handleFromHref(el, rawText);
          }
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
        } else if (!config.mention) {
          if (mode === this.MODE.STANDARD) {
            // 雙節點：原生文字已不是 handle，移除獨立節點並還原顯示
            if (el.dataset.rnDual === "1") TooltipManager.restoreDual(el);
            // YouTube 以非 handle 的名稱重新繪製了這個元素：清除上一位留下的狀態
            if (el.dataset.rnReplaced === "yes" && !el.querySelector("[data-rn-span]")) {
              delete el.dataset.rnReplaced;
              delete el.dataset.rnTargetHandle;
            }
            if (!el.dataset.rnReplaced) {
              TooltipManager.attachData(el, null, rawText);
            }
          }
        }
    } catch (err) {
        // 前端異常偵測
        this.reportFrontendError();
    }
  }
  
  // 前端錯誤回報與熔斷
  reportFrontendError() {
    this.frontendErrorCount++;
    const threshold = window.AppConfig.FUSE_CONFIG.FRONTEND_ERROR_THRESHOLD || 20;
    
    if (this.frontendErrorCount >= threshold) {
        if (typeof Logger !== "undefined") Logger.red(`[FUSE] 前端 DOM 操作錯誤過多 (${this.frontendErrorCount})，觸發前端熔斷。`);
        
        // 寫入 Storage 觸發前端熔斷
        chrome.storage.local.set({ 
            [window.AppConfig.FUSE_FE_KEY]: {
                status: "TRIPPED",
                reason: "frontend",
                timestamp: Date.now()
            }
        });
        
        this.stopObservation();
    }
  }

  isHandle(text) {
    return /^@[^\s]+$/.test(text);
  }

  // 顯示文字被截斷或含空白 (例如 "@some-user…") 時，改從連結的 href 取得完整 handle。
  // 只在文字以 "@" 開頭時才使用，避免把本來就顯示名稱的連結也送去查詢。
  handleFromHref(el, rawText) {
    if (!rawText || !rawText.startsWith("@")) return null;
    const link = el.closest("a[href]") || el.querySelector("a[href]");
    const href = link && link.getAttribute("href");
    if (!href) return null;
    const m = href.match(/^(?:https?:\/\/(?:www\.)?youtube\.com)?\/(@[^/?#]+)/);
    if (!m) return null;
    let handle = m[1];
    try {
      handle = decodeURIComponent(handle);
    } catch (e) {
      // 解不開就使用原字串
    }
    return this.isHandle(handle) ? handle : null;
  }

// === 使用 DataBridge 更新元素 ===
  updateElement(handle, element) {
    // 如果前端保險絲熔斷，這裡也不該發送請求或進行更新
    if (this.fuseFrontendStatus === "TRIPPED") return;

    if (handle.includes("\n")) handle = handle.split("\n")[0].trim();

    // 標記目標，防止非同步回來後元素已被重複使用
    element.dataset.rnTargetHandle = handle;
    element.dataset.rnFetching = "true";

    // 呼叫 DataBridge
    DataBridge.getData(handle, (data) => {
      try {
        // 即使資料回來了，渲染前最後一次檢查保險絲
        if (this.fuseFrontendStatus === "TRIPPED") {
            delete element.dataset.rnFetching; // 雖然不渲染，但移除標記以免卡住
            return;
        }

        // 1. 基礎檢查：元素是否還在？目標Handle是否沒變？(防止非同步後的錯置)
        if (!element.isConnected || element.dataset.rnTargetHandle !== handle) {
          return;
        }

        // 2. 失敗處理
        if (!data) {
          delete element.dataset.rnFetching;
          return;
        }

        // 3. 成功處理
        if (!data.isExpired) {
          delete element.dataset.rnFetching;
        }

        // 4. 執行渲染
        this.applyUpdate(element, handle, data);

      } catch (e) {
          this.reportFrontendError(); // 渲染過程出錯也算
      }
    });
  }

  applyUpdate(el, handle, data) {
    // [雙重保險] 渲染函式內部也檢查
    if (this.fuseFrontendStatus === "TRIPPED") return;

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
        // 目標本身是連結時維持直接替換，否則隱藏原生節點會讓連結無法點擊
        if (this.dualNode && el.dataset.rnMention !== "1" && el.tagName !== "A") {
          TooltipManager.renderDual(el, handle, displayName, fullName, data.subs, data.isExpired);
          break;
        }
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
    const onUrlMaybeChanged = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      this.triggerBurstReset();
      // 只有前端保險絲未熔斷時才重新掃描
      if (this.fuseFrontendStatus === "NORMAL") {
        setTimeout(() => this.scanDeep(document.body), 1500);
      }
    };
    // YouTube 單頁導覽完成時會發出 yt-navigate-finish
    document.addEventListener("yt-navigate-finish", onUrlMaybeChanged);
    window.addEventListener("popstate", onUrlMaybeChanged);
    // 備援：部分頁面 (如 Studio) 不發事件，以較低頻率輪詢
    setInterval(onUrlMaybeChanged, 2000);
  }
}

new PageScanner();
