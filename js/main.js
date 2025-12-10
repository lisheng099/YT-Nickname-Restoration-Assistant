// ===========================================================
// Main.js - 主控制器 (PageScanner) [聊天室與留言區專用版]
// 用途：僅針對「聊天室」與「留言區」的 @handle 進行掃描與替換
// ===========================================================

class PageScanner {
  constructor() {
    this.observer = null; 
    this.isScanning = false; 
    this.pendingUpdates = new Map(); 
    
    // 批次處理佇列 ===
    this.mutationQueue = new Set();
    this.mutationTimer = null;
    this.BATCH_DELAY = 200; // 批次處理延遲 (毫秒)

    this.maxLength = window.AppConfig?.DEFAULT_MAX_LENGTH || 20;
    
    // === 限制選擇器範圍 ===
    this.selectors = [
        // --- 1. 留言區 (Comments) ---
        // 舊版留言結構
        "ytd-comment-renderer #author-text span", 
        // 新版留言結構 (View Model)
        "ytd-comment-view-model #author-text span",
        "ytd-comment-view-model h3 > a",

        // --- 2. 聊天室 (Live Chat) ---
        // 一般訊息
        "yt-live-chat-text-message-renderer #author-name",
        // Super Chat (SC)
        "yt-live-chat-paid-message-renderer #author-name",
        // 會員加入訊息
        "yt-live-chat-membership-item-renderer #author-name",
        // 贈送會員通知 (送禮者)
        "ytd-sponsorships-live-chat-gift-purchase-announcement-renderer #author-name",        
        // 接收會員通知 (被抖內者)
        "ytd-sponsorships-live-chat-gift-redemption-announcement-renderer #author-name",

        // 投票欄位 上方
        "yt-live-chat-banner-poll-renderer #metadata-text",
        
        // 投票欄位 下方
        "yt-live-chat-poll-header-renderer .metadata"
    ].join(",");
    
    this.init();
  }

  init() {
    // 限制執行環境：只在頂層視窗或聊天室 iframe 執行
    if (window === window.top || location.pathname.includes("live_chat")) {
        this.loadConfig();
        NameCache.load(() => {
            this.startObservation(); 
            this.setupUrlListener(); 
        });
    }
  }

  loadConfig() {
     if (!chrome || !chrome.storage || !chrome.storage.local) return;
     const { SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY } = window.AppConfig;
     chrome.storage.local.get([SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY], (res) => {
         const settings = res[SETTINGS_KEY];
         if (settings && settings.maxLength) {
             this.maxLength = parseInt(settings.maxLength, 10);
         }
         TooltipManager.setCopyEnabled(res[CLICK_TO_COPY_KEY] === true);
         NameFetcher.setSpeedMode(res[FETCH_SPEED_KEY] || "NORMAL");
     });

     chrome.storage.onChanged.addListener((changes, area) => {
         if (area === "local") {
             if (changes[SETTINGS_KEY]) {
                 const newVal = changes[SETTINGS_KEY].newValue;
                 if (newVal && newVal.maxLength) this.maxLength = parseInt(newVal.maxLength, 10);
             }
             if (changes[CLICK_TO_COPY_KEY]) {
                 TooltipManager.setCopyEnabled(changes[CLICK_TO_COPY_KEY].newValue === true);
             }
             if (changes[FETCH_SPEED_KEY]) {
                 NameFetcher.setSpeedMode(changes[FETCH_SPEED_KEY].newValue || "NORMAL");
             }
         }
     });
  }

  startObservation() {
    if (this.isScanning) return;
    this.isScanning = true;
    Logger.green("PageScanner 已啟動 (嚴格模式：僅聊天室與留言區)。");

    this.scanDeep(document.body);

    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations));
    this.observer.observe(document.body, {
        childList: true, 
        subtree: true,
        attributes: true, // 監聽屬性變化以應對懶加載
        attributeFilter: ["href", "id", "class"] 
    });
  }

  // 過濾 Mutation，只處理相關區域
  handleMutations(mutations) {
      let hasUpdates = false;

      for (const m of mutations) {
          // A. 處理新增節點 (childList)
          if (m.type === "childList" && m.addedNodes.length > 0) {
              m.addedNodes.forEach(node => {
                  if (node.nodeType === 1) { // Element Node
                      // 檢查該節點是否屬於「聊天室」或「留言區」的組件
                      // 這裡使用 tagName 或 class 來快速過濾，避免過度使用 querySelector
                      const tag = node.tagName.toLowerCase();
                      
                      if (tag.includes("yt-live-chat") || // 聊天室相關
                          tag.includes("ytd-comment") ||  // 留言區相關
                          tag.includes("ytd-item-section-renderer")) { // 留言列表容器
                          
                          this.mutationQueue.add(node);
                          hasUpdates = true;
                      } 
                      // 針對一般 div 插入的情況，檢查是否包含我們需要的元素
                      else if (node.querySelector && 
                              (node.querySelector("ytd-comment-view-model") || 
                               node.querySelector("yt-live-chat-text-message-renderer"))) {
                          this.mutationQueue.add(node);
                          hasUpdates = true;
                      }
                  }
              });
          }
          // B. 處理屬性變更 (attributes) - 通常用於動態更新內容的情況
          else if (m.type === "attributes") {
              const target = m.target;
              
              // 僅針對明確是聊天室或留言區的元素進行反應
              const isChat = target.tagName.includes("YT-LIVE-CHAT");
              const isComment = target.tagName.includes("YTD-COMMENT") || target.id === "author-text";

              if (isChat || isComment) {
                  // 往上找最近的容器，確保上下文完整
                  const container = target.closest("ytd-comment-view-model") || 
                                    target.closest("yt-live-chat-text-message-renderer") || 
                                    target.parentElement;
                  
                  if (container) {
                      this.mutationQueue.add(container);
                      hasUpdates = true;
                  }
              }
          }
      }

      if (hasUpdates) {
          this.scheduleBatchProcess();
      }
  }

  // 排程批次處理
  scheduleBatchProcess() {
      if (this.mutationTimer) return;

      this.mutationTimer = setTimeout(() => {
          this.processMutationQueue();
          this.mutationTimer = null;
      }, this.BATCH_DELAY);
  }

  // 執行佇列中的節點掃描
  processMutationQueue() {
      if (this.mutationQueue.size === 0) return;
      
      const nodesToProcess = Array.from(this.mutationQueue);
      this.mutationQueue.clear();

      nodesToProcess.forEach(node => {
          if (node.isConnected) {
              this.scanDeep(node);
          }
      });
  }

  scanDeep(root) {
      if (!root) return;

      // 使用更新後的嚴格選擇器
      if (root.querySelectorAll) {
          const elements = root.querySelectorAll(this.selectors);
          elements.forEach(el => this.processNode(el));
      }

      if (root.shadowRoot) {
          this.scanDeep(root.shadowRoot);
      }

      // 處理 custom elements 的 shadow DOM 或 iframe 內部
      const children = root.children; 
      if (children) {
          for (let i = 0; i < children.length; i++) {
              const child = children[i];
              if (child.shadowRoot) {
                  this.scanDeep(child.shadowRoot);
              }
          }
      }
  }

  processNode(el) {
      // 取得文字內容，並去除前後空白
      let rawText = (el.textContent || "").trim();

      // 檢查是否為「Handle + 其他文字」的混合格式 (針對投票欄位)
      // 使用更嚴謹的判斷：必須以 @ 開頭，且中間有空白分隔
      const handleMatch = rawText.match(/^(@[^ ]+)/);
      const isMixed = handleMatch && rawText.length > handleMatch[1].length && rawText[handleMatch[1].length].match(/\s/);

      if (isMixed) {
          // 情況 S (Special): 混合文字 (Poll Metadata)
          const handle = handleMatch[1]; 
          
          const suffix = rawText.substring(handle.length);
          
          // 暫存後綴文字到 dataset，供 applyUpdate 使用
          el.dataset.rnSuffix = suffix;

          // 針對混合內容，如果已經處理過且目標 Handle 沒變，才跳過
          if (el.dataset.rnReplaced === "yes" && el.dataset.rnTargetHandle === handle) return;

          this.queueForUpdate(handle, el);
          
      } else if (this.isHandle(rawText)) {
          // 情況 A: 內容本身就是純 Handle
          
          // 如果內容只是純 handle，確保清空舊的 suffix (避免複用錯誤資料)
          if (el.dataset.rnSuffix) {
              delete el.dataset.rnSuffix;
          }

          // 嚴格檢查：
          // 1. 已標記為替換過 (replaced=yes)
          // 2. 資料未過期 (expired!=true)
          // 3. 且「當前顯示的文字」確實等於「已快取的名稱」
          // 如果 1,2 成立但 3 不成立 (例如顯示的是 @Handle)，代表元素被回收了，必須重新更新。
          if (el.dataset.rnReplaced === "yes" && 
              el.dataset.rnExpired !== "true" && 
              el.textContent === el.dataset.rnName) {
              return;
          }
          
          this.queueForUpdate(rawText, el);

      } else if (el.dataset.rnHandle) {
          // 情況 B: 元素已有標記 handle
          
          // 同樣應用嚴格檢查
          if (el.dataset.rnReplaced === "yes" && 
              el.dataset.rnExpired !== "true" && 
              el.textContent === el.dataset.rnName) {
              return;
          }

          this.queueForUpdate(el.dataset.rnHandle, el);
      } else {
          // 情況 C: 這可能是一般名稱，先掛上 tooltip 監聽器 (Click-to-Copy)
          TooltipManager.attachData(el, null, rawText);
      }
  }


  isHandle(text) {
      // 簡單判斷：以 @ 開頭且長度大於 1
      return text.startsWith("@") && text.length >= 2;
  }

  queueForUpdate(handle, element) {
      // 標記此元素目前「鎖定」哪個 Handle
      element.dataset.rnTargetHandle = handle;
      
      const cache = NameCache.get(handle);
      
      if (cache) {
          this.applyUpdate(element, handle, cache);
          // 如果快取過期，背景靜默更新
          if (cache.isExpired) {
              this.fetchData(handle, element, true);
          }
      } else {
          // 無快取，直接抓取
          this.fetchData(handle, element, false);
      }
  }

  fetchData(handle, element, isBackground) {
      if (!this.pendingUpdates.has(handle)) {
          this.pendingUpdates.set(handle, new Set());
      }
      this.pendingUpdates.get(handle).add(element);
      
      const doFetch = () => {
          NameFetcher.enqueue(handle, (h, res) => {
              this.flushUpdates(h, res);
          }, isBackground);
      };

      if (isBackground) {
         const delay = 3000 + Math.random() * 3000;
         Logger.info(`[Main] 準備更新過期資料: ${handle} (延遲 ${Math.round(delay)}ms)`);
         setTimeout(() => doFetch(), delay);
      } else {
         Logger.info(`[Main] 準備抓取新資料: ${handle}`);
         doFetch();
      }
  }

  flushUpdates(handle, data) {
      const elements = this.pendingUpdates.get(handle);
      if (elements && data) {
          Logger.green(`[Main] 抓取完成: ${handle} -> ${data.name}`);
          elements.forEach(el => this.applyUpdate(el, handle, data));
      }
      this.pendingUpdates.delete(handle);
  }

  applyUpdate(el, handle, data) {
      // 如果 el.dataset.rnTargetHandle 已經變成別的 (因為被回收了)，就立刻停止更新。
      if (el.dataset.rnTargetHandle && el.dataset.rnTargetHandle !== handle) {
          return;
      }

      let displayName = data.name;
      const fullName = data.name; 
      
      // 使用擴充運算子 (...) 將字串轉為陣列，正確處理 Surrogate Pairs (表情符號)
      // 這避免了將一個 4-byte 的表情符號切成兩半導致的亂碼 ()
      const chars = [...displayName];
      if (chars.length > this.maxLength) {
          displayName = chars.slice(0, this.maxLength).join("") + "...";
      }
      
      TooltipManager.renderText(el, handle, displayName, data.subs, data.isExpired);
      
      if (fullName !== displayName) {
          TooltipManager.attachData(el, handle, fullName, data.subs, data.isExpired);
      }
  }
  
  setupUrlListener() {
      let lastUrl = location.href;
      // 定期檢查 URL 變化 (SPA 換頁)
      setInterval(() => {
          if (location.href !== lastUrl) {
              lastUrl = location.href;
              // 換頁後給一點時間載入 DOM，再進行全掃描
              setTimeout(() => this.scanDeep(document.body), 1500); 
          }
      }, 500);
  }
}

new PageScanner();