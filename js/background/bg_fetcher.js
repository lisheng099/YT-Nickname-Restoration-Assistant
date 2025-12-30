// ===========================================================
// bg_fetcher.js - 背景網路請求管理器
// ===========================================================

const BgFetcher = {
  queue: { high: [], low: [] },
  isProcessing: false,
  lastFetchTime: 0,
  activeTasks: new Map(), // 正在進行中的網路請求 { handle: [resolveFns...] }
  
  // 錯誤計數器 (用於觸發後端熔斷)
  consecutiveErrors: 0,
  
  // 保險絲狀態 (從 Storage 同步) - 僅關注後端
  fuseBackend: { status: "NORMAL", reason: null },

  // 測試用模擬開關
  // 使用方式：在背景頁面的 Console 輸入 BgFetcher.SIMULATE_ERROR = 'PARSE'
  SIMULATE_ERROR: null, // 可選值: null (正常), 'NETWORK' (網路錯誤), 'PARSE' (解析失敗)

  DELAY: { MIN: 1500, MAX: 3000 },
  
  tabQuotas: new Map(),
  initialPollQuota: 20,
  INITIAL_POLL_DELAY: { MIN: 100, MAX: 300 },

  init: function () {
    chrome.storage.local.get([AppConfig.FETCH_SPEED_KEY, AppConfig.FUSE_BE_KEY], (res) => {
      this.updateSpeedMode(res[AppConfig.FETCH_SPEED_KEY]);
      
      // 初始化後端保險絲狀態
      if (res[AppConfig.FUSE_BE_KEY]) {
        this.fuseBackend = res[AppConfig.FUSE_BE_KEY];
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes[AppConfig.FETCH_SPEED_KEY]) {
          this.updateSpeedMode(changes[AppConfig.FETCH_SPEED_KEY].newValue);
        }
        // 監聽後端保險絲狀態變更
        if (changes[AppConfig.FUSE_BE_KEY]) {
          this.fuseBackend = changes[AppConfig.FUSE_BE_KEY].newValue;
          Logger.info(`[BgFetcher] 後端保險絲狀態更新: ${this.fuseBackend.status}`);
        }
      }
    });
  },

  // 查詢並等待執行中的任務 (Request Coalescing)
  getRunningTask: function (handle) {
    if (this.activeTasks.has(handle)) {
      Logger.info(`[Fetcher] 攔截重複請求 (In-Flight): ${handle}`);
      return new Promise((resolve) => {
        this.activeTasks.get(handle).push(resolve);
      });
    }
    return null;
  },

  updateSpeedMode: function (mode) {
    const presets = AppConfig.SPEED_PRESETS;
    if (presets && presets[mode]) {
      this.DELAY = { MIN: presets[mode].MIN, MAX: presets[mode].MAX };
      // 顯示時間範圍
      Logger.info(
        `[BgFetcher] 速度模式更新: ${mode} (${this.DELAY.MIN}-${this.DELAY.MAX}ms)`
      );
    }
  },

  fetch: function (
    handle,
    priority = "high",
    forceRefresh = false,
    tabId = null
  ) {
    return new Promise((resolve) => {
      // 檢查後端保險絲狀態
      // 如果後端熔斷，直接回傳特殊錯誤代碼，不進入佇列
      if (this.fuseBackend.status === "TRIPPED") {
        resolve({ error: "Fuse Tripped", status: 503 });
        return;
      }

      if (tabId && !this.tabQuotas.has(tabId)) {
        this.tabQuotas.set(tabId, this.initialPollQuota);
      }

      // 請求去重 (Merge Requests)
      if (this.activeTasks.has(handle)) {
        if (priority === "high") {
          this.promoteTask(handle, tabId);
        }
        Logger.orange(`[Duplicate] ${handle} 正在抓取中，合併請求。`);
        this.activeTasks.get(handle).push(resolve);
        return;
      }

      // 建立新任務
      this.activeTasks.set(handle, [resolve]);

      const taskItem = { handle, tabId };
      if (priority === "high") {
        this.queue.high.unshift(taskItem);
      } else {
        this.queue.low.push(taskItem);
      }

      // 顯示待處理數量
      const pendingCount = this.queue.high.length + this.queue.low.length;
      Logger.info(
        `[Queue] 加入: ${handle} (優先級: ${priority}, 待處理: ${pendingCount})`
      );

      this.processQueue();
    });
  },

  promoteTask: function (handle, tabId) {
    let foundIndex = -1;
    let foundQueue = null;

    // 檢查 High Queue
    foundIndex = this.queue.high.findIndex((t) => t.handle === handle);
    if (foundIndex !== -1) {
      foundQueue = this.queue.high;
    } else {
      // 檢查 Low Queue
      foundIndex = this.queue.low.findIndex((t) => t.handle === handle);
      if (foundIndex !== -1) {
        foundQueue = this.queue.low;
      }
    }

    if (foundIndex !== -1 && foundQueue) {
      const task = foundQueue.splice(foundIndex, 1)[0];
      if (tabId) task.tabId = tabId;
      this.queue.high.unshift(task);
      Logger.info(`[Promote] ${handle} 優先權提升至首位`);
    }
  },

  processQueue: async function () {
    // 增加後端保險絲狀態檢查
    if (this.isProcessing || this.fuseBackend.status === "TRIPPED") return;
    if (this.queue.high.length === 0 && this.queue.low.length === 0) return;

    this.isProcessing = true;

    while (this.queue.high.length > 0 || this.queue.low.length > 0) {
      // 增加後端保險絲狀態檢查
      if (this.fuseBackend.status === "TRIPPED") break;

      const nextTask =
        this.queue.high.length > 0 ? this.queue.high[0] : this.queue.low[0];
      const currentTabId = typeof nextTask === "object" ? nextTask.tabId : null;

      // 判斷加速模式
      let isBurst = false;
      let minDelay = this.DELAY.MIN;
      let maxDelay = this.DELAY.MAX;

      // 如果有額度且沒有後端連續錯誤，則允許加速
      if (
        currentTabId &&
        this.tabQuotas.get(currentTabId) > 0 &&
        this.consecutiveErrors === 0
      ) {
        isBurst = true;
        minDelay = this.INITIAL_POLL_DELAY.MIN;
        maxDelay = this.INITIAL_POLL_DELAY.MAX;
      }

      // 隨機延遲
      const now = Date.now();
      const elapsed = now - this.lastFetchTime;
      const requiredDelay =
        Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

      if (elapsed < requiredDelay) {
        await new Promise((r) => setTimeout(r, requiredDelay - elapsed));
      }

      // 取出任務
      const task =
        this.queue.high.length > 0
          ? this.queue.high.shift()
          : this.queue.low.shift();
      const handle = typeof task === "object" ? task.handle : task;

      try {
        // 顯示距上次抓取時間
        const currentGap = Date.now() - this.lastFetchTime;
        const gapInfo =
          this.lastFetchTime === 0 ? "首次執行" : `${currentGap}ms`;

        Logger.info(`[Fetch Start] 正在抓取 ${handle}... (距上次: ${gapInfo})`);

        this.lastFetchTime = Date.now();
        const result = await this.doNetworkFetch(handle);

        if (result.success) {
          // 顯示訂閱數
          Logger.green(
            `[Fetch OK] ${handle} -> ${result.nameRaw} (${result.subs})`
          );

          // 寫入 Cache
          BgCache.set(handle, { name: result.nameRaw, subs: result.subs });
          
          // 成功時重置錯誤計數
          this.consecutiveErrors = 0;

          if (isBurst && currentTabId) {
            const left = this.tabQuotas.get(currentTabId) - 1;
            this.tabQuotas.set(currentTabId, left);
            // 顯示剩餘額度
            Logger.info(`[Burst] Tab ${currentTabId} 剩餘額度: ${left}`);
          }
        } else {
          Logger.orange(`[Fetch Fail] ${handle}: ${result.error}`);
          // 如果是資料找不到 (可能YT改版)，檢查健康度
          if (result.error === "Name not found") {
             this.checkBackendHealth();
          }
        }

        const waiters = this.activeTasks.get(handle) || [];
        waiters.forEach((resolve) => resolve(result));
      } catch (err) {
        Logger.red(`[Fetch Error] ${handle}:`, err);
        const waiters = this.activeTasks.get(handle) || [];
        waiters.forEach((resolve) => resolve({ error: err.message }));
      } finally {
        this.activeTasks.delete(handle);
      }
    }

    this.isProcessing = false;
  },

  doNetworkFetch: async function (handle) {
    // === 模擬測試區塊 ===
    if (this.SIMULATE_ERROR) {
       Logger.orange(`[Debug] 模擬故障模式啟動: ${this.SIMULATE_ERROR}`);
       
       // 模擬 1: 網路層級錯誤 (如 429 Too Many Requests)
       if (this.SIMULATE_ERROR === "NETWORK") {
           this.consecutiveErrors++;
           this.checkBackendHealth();
           return { error: "Simulated Network Error (429)", status: 429 };
       }
       
       // 模擬 2: 解析層級錯誤 (YT 改版導致抓不到 Name)
       if (this.SIMULATE_ERROR === "PARSE") {
           // 回傳 "Name not found" 會讓 processQueue 去呼叫 checkBackendHealth
           return { error: "Name not found" }; 
       }
    }
    // =========================

    if (!handle) return { error: "Invalid handle" };
    const cleanHandle = handle.replace(/^@/, "");
    const targetUrl = `https://www.youtube.com/@${encodeURIComponent(
      cleanHandle
    )}`;

    let controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { "Accept-Language": "zh-TW", "Cache-Control": "no-cache" },
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        // 429 錯誤也納入計數
        this.consecutiveErrors++;
        this.checkBackendHealth();
        return { error: "Too Many Requests", status: 429 };
      }

      if (
        response.url.includes("google.com/accounts") ||
        response.url.includes("consent.youtube.com")
      ) {
        return { error: "Redirected to login", status: 429 };
      }

      if (!response.ok) return { error: `HTTP ${response.status}` };

      const text = await response.text();
      const parsed = YTParser.parse(text);

      if (parsed)
        return { success: true, nameRaw: parsed.nameRaw, subs: parsed.subs };
      
      // 解析失敗 (抓不到資料)
      return { error: "Name not found" };
    } catch (err) {
      clearTimeout(timeoutId);
      return { error: err.message };
    }
  },

  // 檢查後端健康狀態
  checkBackendHealth: function () {
    this.consecutiveErrors++;
    const threshold = AppConfig.FUSE_CONFIG.BACKEND_ERROR_THRESHOLD || 10;
    Logger.orange(`[Health] 連續錯誤: ${this.consecutiveErrors}/${threshold}`);
    
    if (this.consecutiveErrors >= threshold) {
      this.tripFuse("backend");
    }
  },

  // 觸發後端熔斷
  tripFuse: function (reasonType) {
    Logger.red(`[FUSE] 後端保險絲熔斷啟動！原因: ${reasonType}`);
    const newState = {
      status: "TRIPPED",
      reason: reasonType,
      timestamp: Date.now()
    };
    
    // 寫入 Storage (僅更新後端保險絲 Key)
    chrome.storage.local.set({ [AppConfig.FUSE_BE_KEY]: newState });
    
    // 清空當前佇列
    this.queue.high = [];
    this.queue.low = [];
    this.activeTasks.clear();
  },

  resetQuota: function (tabId) {
    if (tabId) this.tabQuotas.set(tabId, this.initialPollQuota);
  },
  
  // === 清除已關閉分頁的額度資料 ===
  cleanupTab: function (tabId) {
    if (this.tabQuotas.has(tabId)) {
      this.tabQuotas.delete(tabId);
      Logger.info(`[BgFetcher] 已清除關閉分頁的 Quota: Tab ${tabId}`);
    }
  }
};

BgFetcher.init();
