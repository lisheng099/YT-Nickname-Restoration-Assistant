// ===========================================================
// bg_fetcher.js - 背景網路請求管理器 (Log 增強版)
// ===========================================================

const BgFetcher = {
  queue: { high: [], low: [] },
  isProcessing: false,
  lastFetchTime: 0,
  activeTasks: new Map(),
  errorCount: 0,
  isCircuitOpen: false,
  DELAY: { MIN: 1500, MAX: 3000 },
  CIRCUIT: { THRESHOLD: 3, DURATION: 300000 },
  tabQuotas: new Map(), // 記錄每個 tabId 剩餘的加速次數
  initialPollQuota: 20, // 每個分頁預設給 20 次
  INITIAL_POLL_DELAY: { MIN: 100, MAX: 300 }, // 加速時的間隔

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

  updateSpeedMode: function (mode) {
    const presets = AppConfig.SPEED_PRESETS;
    if (presets && presets[mode]) {
      this.DELAY = { MIN: presets[mode].MIN, MAX: presets[mode].MAX };
      // [Log] 顯示模式變更
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
      // 1. 檢查快取
      // 如果是強制更新 (forceRefresh 為 true)，則跳過快取檢查
      if (!forceRefresh) {
        const cached = BgCache.get(handle);
        if (cached) {
          // Logger.info(`[Cache Hit] ${handle}`);
          resolve({ success: true, nameRaw: cached.name, subs: cached.subs });
          return;
        }
      }

      if (tabId && !this.tabQuotas.has(tabId)) {
        this.tabQuotas.set(tabId, this.initialPollQuota);
      }

      // 2. 請求去重
      if (this.activeTasks.has(handle)) {
        // 嘗試在佇列中找到該任務，並提升優先級
        if (priority === "high") {
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
            // 1. 從舊位置移除
            const task = foundQueue.splice(foundIndex, 1)[0];

            // 2. 更新 TabID (讓最新的互動視窗獲得加速權)
            if (tabId) task.tabId = tabId;

            // 3. 插隊到 High Queue 最前面
            this.queue.high.unshift(task);

            Logger.info(`[Promote] ${handle} 優先權提升至首位`);
          }
        }

        // 請求合併
        Logger.orange(`[Duplicate] ${handle} 正在抓取中，合併請求。`);
        this.activeTasks.get(handle).push(resolve);
        return;
      }

      // 3. 建立新任務
      this.activeTasks.set(handle, [resolve]);

      const taskItem = { handle, tabId };

      if (priority === "high") {
        this.queue.high.unshift(taskItem);
      } else {
        this.queue.low.push(taskItem);
      }

      // [Log] 加入佇列
      Logger.info(
        `[Queue] 加入: ${handle} (優先級: ${priority}, 待處理: ${
          this.queue.high.length + this.queue.low.length
        })`
      );

      this.processQueue();
    });
  },

  processQueue: async function () {
    if (this.isProcessing || this.isCircuitOpen) return;
    if (this.queue.high.length === 0 && this.queue.low.length === 0) return;

    this.isProcessing = true;

    while (this.queue.high.length > 0 || this.queue.low.length > 0) {
      if (this.isCircuitOpen) break;

      // 預看下一個任務 (但不先移除)，為了判斷要用什麼速度
      const nextTask =
        this.queue.high.length > 0 ? this.queue.high[0] : this.queue.low[0];
      // 相容性處理：防止舊代碼塞入字串
      const currentTabId = typeof nextTask === "object" ? nextTask.tabId : null;

      // [核心邏輯] 判斷是否使用加速模式
      let isBurst = false;
      let minDelay = this.DELAY.MIN;
      let maxDelay = this.DELAY.MAX;

      // 條件：該分頁還有額度 且 目前系統無錯誤
      if (
        currentTabId &&
        this.tabQuotas.get(currentTabId) > 0 &&
        this.errorCount === 0
      ) {
        isBurst = true;
        minDelay = this.INITIAL_POLL_DELAY.MIN;
        maxDelay = this.INITIAL_POLL_DELAY.MAX;
      }

      const now = Date.now();
      const elapsed = now - this.lastFetchTime;
      const requiredDelay =
        Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

      if (elapsed < requiredDelay) {
        const wait = requiredDelay - elapsed;
        await new Promise((r) => setTimeout(r, wait));
      }

      // 正式取出任務
      const task =
        this.queue.high.length > 0
          ? this.queue.high.shift()
          : this.queue.low.shift();
      const handle = typeof task === "object" ? task.handle : task; // 取得 handle 字串

      try {
        const currentGap = Date.now() - this.lastFetchTime;
        const gapInfo =
          this.lastFetchTime === 0 ? "首次執行" : `${currentGap}ms`;

        // [Log] 顯示距離上次抓取的時間差
        if (typeof Logger !== "undefined")
          Logger.info(
            `[Fetch Start] 正在抓取 ${handle}... (距上次: ${gapInfo})`
          );
        this.lastFetchTime = Date.now();
        const result = await this.doNetworkFetch(handle);

        if (result.success) {
          // [Log] 抓取成功
          Logger.green(
            `[Fetch OK] ${handle} -> ${result.nameRaw} (${result.subs})`
          );

          BgCache.set(handle, { name: result.nameRaw, subs: result.subs });
          this.errorCount = 0;

          if (isBurst && currentTabId) {
            const left = this.tabQuotas.get(currentTabId) - 1;
            this.tabQuotas.set(currentTabId, left);
            Logger.info(`[Burst] Tab ${currentTabId} 剩餘額度: ${left}`);
          }
        } else {
          // [Log] 抓取失敗 (業務邏輯失敗)
          Logger.orange(`[Fetch Fail] ${handle}: ${result.error}`);
        }

        const waiters = this.activeTasks.get(handle) || [];
        waiters.forEach((resolve) => resolve(result));
      } catch (err) {
        // [Log] 系統錯誤
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

      if (parsed) {
        return { success: true, nameRaw: parsed.nameRaw, subs: parsed.subs };
      } else {
        return { error: "Name not found" };
      }
    } catch (err) {
      clearTimeout(timeoutId);
      return { error: err.message };
    }
  },

  triggerCircuitBreaker: function () {
    this.errorCount++;
    // [Log] 熔斷警告
    Logger.red(
      `[Circuit] 錯誤計數: ${this.errorCount}/${this.CIRCUIT.THRESHOLD}`
    );

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
        Logger.green(`[Circuit Breaker] 系統恢復，繼續處理佇列。`);
        this.processQueue();
      }, this.CIRCUIT.DURATION);
    }
  },
  // 重置特定分頁的加速額度
  resetQuota: function (tabId) {
    if (tabId) {
      this.tabQuotas.set(tabId, this.initialPollQuota);
      Logger.info(`[Burst] Tab ${tabId} 加速額度已重置`);
    }
  },
};

BgFetcher.init();
