// ===========================================================
// Fetcher.js - 網路請求管理器
// 用途：負責執行 YouTube 頁面抓取任務，包含佇列管理與流量控制。
// 關鍵機制：全域鎖、優先級佇列、指數退避、熔斷機制。
// ===========================================================

const NameFetcher = {
  // 1. 任務佇列 (Task Queue)
  // high: 高優先級 (使用者當前可見的元素)
  // low:  低優先級 (過期資料的背景更新)
  queue: {
    high: [], 
    low: []   
  },
  
  // 2. 請求去重 (Deduplication)
  // 記錄正在處理中的 Handle，避免對同一 ID 重複發送請求。
  activeRequests: new Set(),
  
  // 狀態旗標
  isProcessing: false,
  isCircuitBreakerActive: false, // 熔斷開關
  
  // 錯誤計數器 (用於計算退避時間)
  errorCount: 0,

  // 請求間隔設定 (毫秒) - 將由 Config 覆寫
  delaySettings: { min: 1500, max: 3000 },
  
  // 初始輪詢設定 (Initial Polling)
  // 頁面載入初期以較高頻率抓取，確保資料快速呈現
  initialPollQuota: 10,  // 初始額度
  INITIAL_POLL_DELAY: { MIN: 100, MAX: 300 }, // 間隔
  
  // 熔斷機制設定
  // 條件：連續錯誤 3 次
  // 行為：暫停所有請求 5 分鐘 (300秒)
  CIRCUIT: { THRESHOLD: 3, DURATION: 5 * 60 * 1000 },

  // 全域同步控制鍵值
  GLOBAL_FETCH_KEY: "yt_realname_global_fetch_ts",
  FETCH_LOCK_NAME: "yt_realname_fetch_lock",

  setSpeedMode: function(mode) {
      const presets = window.AppConfig?.SPEED_PRESETS;
      if (presets && presets[mode]) {
          this.delaySettings = { 
              min: presets[mode].MIN, 
              max: presets[mode].MAX 
          };
      }
      Logger.info(`Fetch 速度模式已更新: ${mode}`);
  },

  // 將請求加入佇列
  enqueue: function(handle, callback, isBackgroundUpdate = false, timestamp = Date.now()) {
    if (this.isCircuitBreakerActive) return; // 熔斷中，拒絕新請求

    const task = { handle, callback, ts: timestamp };
    
    const existingIndex = this.queue.high.findIndex(t => t.handle === handle);

    if (existingIndex !== -1) {
        // [情況 A] 已在排隊：從舊位置移除，準備重新加入到最前面
        this.queue.high.splice(existingIndex, 1);
        Logger.info(`[Fetcher] 優先權提升: ${handle} (重新出現)`);
    } else if (this.activeRequests.has(handle)) {
        // [情況 B] 正在執行中 (Processing)：無法插隊，直接返回
        return;
    }
    
    this.activeRequests.add(handle);

    if (isBackgroundUpdate) {
        this.queue.low.push(task); // 背景任務維持 FIFO 或自行決定
    } else {
        // 使用 unshift 代替 push，將最新的任務直接放到陣列最前面 (LIFO)
        // 這樣 startQueue 的 shift() 取出時，就會先取出這一個
        this.queue.high.unshift(task);
    }
    
    this.startQueue();
  },

  // 佇列處理器 (Consumer Loop)
  startQueue: async function() {
    if (this.isProcessing) return; // 確保單一執行緒
    if (this.isCircuitBreakerActive) return;

    const { high, low } = this.queue;
    if (high.length === 0 && low.length === 0) return;

    this.isProcessing = true;

    while (high.length > 0 || low.length > 0) {
      if (this.isCircuitBreakerActive) break;

      // 全域流量控制核心邏輯
      // 使用 Web Locks API 確保跨分頁互斥 (同一時間只有一個分頁能進入此區塊)
      const shouldFetch = await navigator.locks.request(this.FETCH_LOCK_NAME, async () => {
          return new Promise((resolve) => {
              // 1. 讀取全域最後抓取時間
              chrome.storage.local.get(this.GLOBAL_FETCH_KEY, (res) => {
                  const lastTs = res[this.GLOBAL_FETCH_KEY] || 0;
                  const now = Date.now();
                  const { min } = this.delaySettings;
                  
                  // === 初始輪詢模式判斷 ===
                  // 條件：還有額度 且 目前沒有錯誤 (安全考量)
                  let isBurst = false;
                  let currentRequiredGap = min + (this.errorCount * 1000); // 預設間隔 (含退避)

                  if (this.initialPollQuota > 0 && this.errorCount === 0) {
                      isBurst = true;
                      currentRequiredGap = this.INITIAL_POLL_DELAY.MAX; // 啟用極速間隔 (0.3s)
                  }

                  // 加入隨機波動 (Jitter)
                  // 若是初始輪詢模式，減少波動時間以確保速度；一般模式則維持較大波動以避免搶鎖
                  const jitterMax = isBurst ? 50 : 500;
                  const randomJitter = Math.floor(Math.random() * jitterMax);
                  
                  if (now - lastTs < currentRequiredGap) {
                      // 距離上次全域抓取時間太短，本分頁暫時讓出
                      resolve({ allow: false, waitTime: currentRequiredGap - (now - lastTs) + randomJitter });
                  } else {
                      // 允許抓取，並立刻更新全域時間戳記 (佔位)
                      chrome.storage.local.set({ [this.GLOBAL_FETCH_KEY]: now }, () => {
                          // 若使用了初始輪詢模式，扣除額度
                          if (isBurst) {
                              this.initialPollQuota--;
                              Logger.info(`[Fetcher] 使用加速額度 (剩餘: ${this.initialPollQuota})`);
                          }
                          resolve({ allow: true, isBurst: isBurst });
                      });
                  }
              });
          });
      });

      if (!shouldFetch.allow) {
          // 被全域限流擋下，等待一段時間後再試 (不佔用 CPU)
          // 注意：這裡不離開 while 迴圈，而是等待後繼續嘗試處理佇列
          await new Promise(r => setTimeout(r, shouldFetch.waitTime));
          continue; // 重新進入迴圈開頭，重新搶鎖
      }

      // 取得任務執行
      const task = high.length > 0 ? high.shift() : low.shift();
      const { handle, callback } = task;

      try {
          const result = await this.performFetch(handle);
          if (result) {
              // 請求成功：重置錯誤計數
              if (this.errorCount > 0) {
                  this.errorCount = 0;
                  Logger.green(`網路連線恢復穩定，重置錯誤計數。`);
              }
              
              NameCache.set(handle, result);
              if (callback) callback(handle, result);
          } else {
              // 請求失敗 (如 404)：移除處理狀態
              if (callback) callback(handle, null);
          }
      } catch (err) {
          Logger.red("任務執行異常:", err);
          // 發生錯誤時，仍需通知 callback 以釋放記憶體
          if (callback) callback(handle, null);
      } finally {
          // 確保無論成功、失敗或報錯，都清除鎖定狀態
          this.activeRequests.delete(handle);
      }

      // 任務完成後的本地冷卻
      // 如果剛剛是初始輪詢模式，本地也只需要等待短時間，以便盡快處理下一個
      let localWait;
      if (shouldFetch.isBurst) {
          const { MIN, MAX } = this.INITIAL_POLL_DELAY;
          localWait = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
      } else {
          const { min, max } = this.delaySettings;
          localWait = Math.floor(Math.random() * (max - min + 1)) + min;
      }
      
      await new Promise(r => setTimeout(r, localWait));
    }

    this.isProcessing = false;
  },

  // 執行單次爬蟲請求
  performFetch: async function(handle) {
    return new Promise((resolve, reject) => { // 參數改為 resolve, reject
      // 傳送訊息給 background.js
      chrome.runtime.sendMessage({ 
          type: "FETCH_CHANNEL_INFO", 
          handle: handle 
      }, (response) => {
          
          // 1. Runtime 連線錯誤 (Extension 異常/斷線) -> 視為嚴重錯誤，拋出 reject
          if (chrome.runtime.lastError) {
              Logger.red("Background communication error:", chrome.runtime.lastError.message);
              reject(new Error(chrome.runtime.lastError.message)); 
              return;
          }

          // 2. Response 為空 -> 視為錯誤
          if (!response) {
              reject(new Error("Empty response"));
              return;
          }

          // 3. 處理 429 Too Many Requests
          if (response.status === 429) {
              this.handleRateLimit(); // 觸發熔斷
              resolve(null); // 已處理熔斷，此次回傳空即可
              return;
          }

          // 4. 處理其他邏輯錯誤
          if (!response.success || response.error) {
              // 如果是 "Name not found" (404)，這是正常業務結果，不計入錯誤
              if (response.error === "Name not found") {
                  resolve(null);
              } else {
                  // 其他如網路中斷、Redirect 失敗等 -> 拋出 reject 讓外層計數
                  reject(new Error(response.error));
              }
              return;
          }

          // 5. 資料後處理 (成功)
          let finalName = response.nameRaw;
          // decodeHtmlEntities 來自 utils.js，已在 content_scripts 載入，可直接使用
          if (typeof decodeHtmlEntities === "function") {
              finalName = decodeHtmlEntities(finalName);
          }
          if (finalName === "YouTube") { resolve(null); return; }

          const finalSubs = response.subs || 0;

          resolve({ name: finalName, subs: finalSubs });
      });
    });
  },

  // 處理 Rate Limit 限制
  handleRateLimit: function() {
      // 429 錯誤較嚴重，增加權重以快速觸發熔斷
      this.errorCount += 2; 
      Logger.red(`偵測到 YouTube 限流 (目前錯誤計數: ${this.errorCount})`);
      
      if (this.errorCount >= this.CIRCUIT.THRESHOLD) {
          this.isCircuitBreakerActive = true;
          Logger.red(`啟動熔斷機制 (Circuit Breaker)，系統暫停 ${this.CIRCUIT.DURATION / 1000} 秒`);
          
          setTimeout(() => {
              this.isCircuitBreakerActive = false;
              this.errorCount = 0;
              this.startQueue(); // 冷卻時間結束，恢復運作
          }, this.CIRCUIT.DURATION);
      }
  },


};