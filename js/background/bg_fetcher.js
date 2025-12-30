// ===========================================================
// bg_fetcher.js - 背景網路請求管理器
// ===========================================================

const BgFetcher = {
  queue: { high: [], low: [] },
  isProcessing: false,
  lastFetchTime: 0,
  activeTasks: new Map(), // 正在進行中的網路請求 { handle: [resolveFns...] }
  errorCount: 0,
  isCircuitOpen: false,
  DELAY: { MIN: 1500, MAX: 3000 },
  CIRCUIT: { THRESHOLD: 3, DURATION: 300000 },
  tabQuotas: new Map(),
  initialPollQuota: 20,
  INITIAL_POLL_DELAY: { MIN: 100, MAX: 300 },

  init: function () {
    chrome.storage.local.get(AppConfig.FETCH_SPEED_KEY, (res) => {
      this.updateSpeedMode(res[AppConfig.FETCH_SPEED_KEY]);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[AppConfig.FETCH_SPEED_KEY]) {
        this.updateSpeedMode(changes[AppConfig.FETCH_SPEED_KEY].newValue);
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
    if (this.isProcessing || this.isCircuitOpen) return;
    if (this.queue.high.length === 0 && this.queue.low.length === 0) return;

    this.isProcessing = true;

    while (this.queue.high.length > 0 || this.queue.low.length > 0) {
      if (this.isCircuitOpen) break;

      const nextTask =
        this.queue.high.length > 0 ? this.queue.high[0] : this.queue.low[0];
      const currentTabId = typeof nextTask === "object" ? nextTask.tabId : null;

      // 判斷加速模式
      let isBurst = false;
      let minDelay = this.DELAY.MIN;
      let maxDelay = this.DELAY.MAX;

      if (
        currentTabId &&
        this.tabQuotas.get(currentTabId) > 0 &&
        this.errorCount === 0
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
          this.errorCount = 0;

          if (isBurst && currentTabId) {
            const left = this.tabQuotas.get(currentTabId) - 1;
            this.tabQuotas.set(currentTabId, left);
            // 顯示剩餘額度
            Logger.info(`[Burst] Tab ${currentTabId} 剩餘額度: ${left}`);
          }
        } else {
          Logger.orange(`[Fetch Fail] ${handle}: ${result.error}`);
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
        this.triggerCircuitBreaker();
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
      return { error: "Name not found" };
    } catch (err) {
      clearTimeout(timeoutId);
      return { error: err.message };
    }
  },

  triggerCircuitBreaker: function () {
    this.errorCount++;
    if (this.errorCount >= this.CIRCUIT.THRESHOLD) {
      this.isCircuitOpen = true;
      Logger.red(
        `[Circuit Breaker] 熔斷啟動！暫停抓取 ${
          this.CIRCUIT.DURATION / 1000
        } 秒`
      );
      setTimeout(() => {
        this.isCircuitOpen = false;
        this.errorCount = 0;
        this.processQueue();
      }, this.CIRCUIT.DURATION);
    }
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
