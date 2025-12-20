// ===========================================================
// bg_fetcher.js - 背景網路請求管理器 (Log 增強版)
// ===========================================================

const BgFetcher = {
    // ... (前面屬性保持不變)
    queue: { high: [], low: [] },
    isProcessing: false,
    activeTasks: new Map(),
    errorCount: 0,
    isCircuitOpen: false,
    DELAY: { MIN: 1500, MAX: 3000 }, 
    CIRCUIT: { THRESHOLD: 3, DURATION: 300000 },

    init: function() {
        chrome.storage.local.get(AppConfig.FETCH_SPEED_KEY, (res) => {
            this.updateSpeedMode(res[AppConfig.FETCH_SPEED_KEY]);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[AppConfig.FETCH_SPEED_KEY]) {
                this.updateSpeedMode(changes[AppConfig.FETCH_SPEED_KEY].newValue);
            }
        });
    },

    updateSpeedMode: function(mode) {
        const presets = AppConfig.SPEED_PRESETS;
        if (presets && presets[mode]) {
            this.DELAY = { min: presets[mode].MIN, max: presets[mode].MAX };
            // [Log] 顯示模式變更
            Logger.info(`[BgFetcher] 速度模式更新: ${mode} (${this.DELAY.min}-${this.DELAY.max}ms)`);
        }
    },

    fetch: function(handle, priority = 'high', forceRefresh = false) {
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

            // 2. 請求去重
            if (this.activeTasks.has(handle)) {
                Logger.orange(`[Duplicate] ${handle} 正在抓取中，合併請求。`);
                this.activeTasks.get(handle).push(resolve);
                return;
            }

            // 3. 建立新任務
            this.activeTasks.set(handle, [resolve]);
            
            if (priority === 'high') {
                this.queue.high.push(handle);
            } else {
                this.queue.low.push(handle);
            }
            
            // [Log] 加入佇列
            Logger.info(`[Queue] 加入: ${handle} (優先級: ${priority}, 待處理: ${this.queue.high.length + this.queue.low.length})`);

            this.processQueue();
        });
    },

    processQueue: async function() {
        if (this.isProcessing || this.isCircuitOpen) return;
        if (this.queue.high.length === 0 && this.queue.low.length === 0) return;

        this.isProcessing = true;

        while (this.queue.high.length > 0 || this.queue.low.length > 0) {
            if (this.isCircuitOpen) break;

            const handle = this.queue.high.length > 0 ? this.queue.high.shift() : this.queue.low.shift();
            
            try {
                // [Log] 開始抓取
                Logger.info(`[Fetch Start] 正在抓取 ${handle}...`);
                
                const result = await this.doNetworkFetch(handle);
                
                if (result.success) {
                    // [Log] 抓取成功
                    Logger.green(`[Fetch OK] ${handle} -> ${result.nameRaw} (${result.subs})`);
                    
                    BgCache.set(handle, { name: result.nameRaw, subs: result.subs });
                    this.errorCount = 0; 
                } else {
                    // [Log] 抓取失敗 (業務邏輯失敗)
                    Logger.orange(`[Fetch Fail] ${handle}: ${result.error}`);
                }

                const waiters = this.activeTasks.get(handle) || [];
                waiters.forEach(resolve => resolve(result));

            } catch (err) {
                // [Log] 系統錯誤
                Logger.red(`[Fetch Error] ${handle}:`, err);
                const waiters = this.activeTasks.get(handle) || [];
                waiters.forEach(resolve => resolve({ error: err.message }));
            } finally {
                this.activeTasks.delete(handle);
            }

            // 隨機延遲
            const waitTime = Math.floor(Math.random() * (this.DELAY.MAX - this.DELAY.MIN + 1)) + this.DELAY.MIN;
            await new Promise(r => setTimeout(r, waitTime));
        }

        this.isProcessing = false;
    },

    doNetworkFetch: async function(handle) {
        // ... (這部分網路請求邏輯與之前相同，省略以節省篇幅)
        if (!handle) return { error: "Invalid handle" };
        const cleanHandle = handle.replace(/^@/, '');
        const targetUrl = `https://www.youtube.com/@${encodeURIComponent(cleanHandle)}`;

        let controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), 20000);

        try {
            const response = await fetch(targetUrl, {
                method: "GET",
                signal: controller.signal,
                headers: { "Accept-Language": "zh-TW", "Cache-Control": "no-cache" }
            });

            clearTimeout(timeoutId);

            if (response.status === 429) {
                this.triggerCircuitBreaker();
                return { error: "Too Many Requests", status: 429 };
            }
            
            if (response.url.includes("google.com/accounts") || response.url.includes("consent.youtube.com")) {
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

    triggerCircuitBreaker: function() {
        this.errorCount++;
        // [Log] 熔斷警告
        Logger.red(`[Circuit] 錯誤計數: ${this.errorCount}/${this.CIRCUIT.THRESHOLD}`);
        
        if (this.errorCount >= this.CIRCUIT.THRESHOLD) {
            this.isCircuitOpen = true;
            Logger.red(`[Circuit Breaker] 熔斷啟動！暫停抓取 ${this.CIRCUIT.DURATION / 1000} 秒`);
            
            setTimeout(() => {
                this.isCircuitOpen = false;
                this.errorCount = 0;
                Logger.green(`[Circuit Breaker] 系統恢復，繼續處理佇列。`);
                this.processQueue();
            }, this.CIRCUIT.DURATION);
        }
    }
};

BgFetcher.init();