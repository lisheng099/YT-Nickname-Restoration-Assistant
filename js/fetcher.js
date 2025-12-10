// ===========================================================
// Fetcher.js - 網路請求管理器
// 用途：負責執行 YouTube 頁面抓取任務，包含佇列管理與流量控制。
// 關鍵機制：優先級佇列、指數退避 (Exponential Backoff)、熔斷機制 (Circuit Breaker)。
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
  
  // 熔斷機制設定
  // 條件：連續錯誤 3 次
  // 行為：暫停所有請求 5 分鐘 (300秒)
  CIRCUIT: { THRESHOLD: 3, DURATION: 5 * 60 * 1000 },

  // 設定請求速度模式
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
  enqueue: function(handle, callback, isBackgroundUpdate = false) {
    if (this.isCircuitBreakerActive) return; // 熔斷中，拒絕新請求
    if (this.activeRequests.has(handle)) return; // 請求已存在，去重
    
    this.activeRequests.add(handle);
    const task = { handle, callback };
    
    // 依據優先級分流
    if (isBackgroundUpdate) {
        this.queue.low.push(task);
    } else {
        this.queue.high.push(task);
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

      // 優先處理 High Queue
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
              this.activeRequests.delete(handle);
              if (callback) callback(handle, null);
          }
      } catch (err) {
          Logger.red("任務執行異常:", err);
      }

      // === 退避機制 (Backoff Strategy) ===
      // 原理：錯誤次數越多，等待時間越長，避免在網路不穩時發送大量請求。
      const backoffMultiplier = this.errorCount > 0 ? (this.errorCount * 1000) : 0;

      if (high.length > 0 || low.length > 0) {
         const { min, max } = this.delaySettings;
         // 計算總延遲 = 基礎隨機延遲 + 退避懲罰
         const wait = Math.floor(Math.random() * (max - min + 1)) + min + backoffMultiplier;
         
         if (backoffMultiplier > 0) {
             Logger.info(`觸發退避機制，增加延遲: +${backoffMultiplier}ms (總計: ${wait}ms)`);
         }

         await new Promise(r => setTimeout(r, wait));
      }
    }

    this.isProcessing = false;
  },

  // 執行單次爬蟲請求
  performFetch: async function(handle) {
    let timeoutTimer = null;
    try {
      const cleanHandle = handle.replace(/^@/, '');
      const handleAnchor = handle.startsWith("@") ? handle : "@" + handle;
      const targetUrl = `https://www.youtube.com/@${encodeURIComponent(cleanHandle)}`;
      
      // 設定請求逾時 (Timeout) 為 25 秒
      const controller = new AbortController();
      timeoutTimer = setTimeout(() => controller.abort(), 25000);

      const response = await fetch(targetUrl, { 
          credentials: "include", // 攜帶 Cookies 以獲取完整資訊
          signal: controller.signal, 
          headers: {
              "Cache-Control": "no-cache", 
              "Accept-Language": "en-US,en;q=0.9" // 強制英文介面以利正則解析
          }
      });

      // 處理 HTTP 429 (Too Many Requests)
      if (response.status === 429) {
          this.handleRateLimit(); 
          clearTimeout(timeoutTimer);
          return null;
      }

      if (!response.ok) {
          // 其他 HTTP 錯誤，視為網路異常並增加錯誤計數
          this.errorCount++;
          clearTimeout(timeoutTimer);
          return null;
      }

      // === 串流解析 (Stream Parsing) ===
      // 優化策略：不需下載完整 HTML，讀取到所需資訊 (名稱、訂閱數) 後即中斷連線。
      // 效益：大幅節省頻寬與記憶體使用。
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      
      let buffer = "";
      let resultName = null;
      let resultSubs = 0;
      let lastCheckIndex = 0;
      
      while (true) {
          const { done, value } = await reader.read();
          if (done) break; 
          
          buffer += decoder.decode(value, { stream: true });
          
          // 解析頻道名稱 (優先檢查 Meta Tags)
          if (!resultName) {
              const ogMatch = buffer.match(/<meta\s+property="og:title"\s+content="([^"]+)">/i);
              if (ogMatch) {
                  let raw = ogMatch[1];
                  resultName = raw.replace(/\s*-\s*YouTube$/, "").trim();
              }
              if (!resultName) {
                  const twMatch = buffer.match(/<meta\s+name="twitter:title"\s+content="([^"]+)">/i);
                  if (twMatch) resultName = twMatch[1];
              }
              if (!resultName) {
                   const jsonMatch = buffer.match(/"name":\s*"([^"]+)"/);
                   if (jsonMatch && !jsonMatch[1].includes("Google")) {
                       resultName = jsonMatch[1];
                   }
              }
          }

          // 解析訂閱數
          // 策略：以 Handle ID 為錨點，向後搜尋 "subscribers" 關鍵字
          if (resultSubs === 0) {
              let anchorIndex = buffer.indexOf(handleAnchor, lastCheckIndex);
              while (anchorIndex !== -1) {
                  const snippet = buffer.slice(anchorIndex, anchorIndex + 2000);
                  const textOnly = snippet.replace(/<[^>]+>/g, " "); // 移除 HTML 標籤干擾
                  const subRegex = /([\d,.]+[KMB萬億]?)\s*(?:位?訂閱者|subscribers)/i;
                  const m = textOnly.match(subRegex);
                  if (m) {
                      const val = this.parseSubsString(m[1]);
                      // 過濾雜訊：忽略過小的數值 (如 < 500)，避免誤判
                      if (val >= 500) {
                          resultSubs = val;
                          break;
                      }
                  }
                  lastCheckIndex = anchorIndex + 1;
                  anchorIndex = buffer.indexOf(handleAnchor, lastCheckIndex);
              }
          }

          // 若資訊已齊全，或下載量超過安全閾值 (1.5MB)，則中斷連線
          if ((resultName && resultSubs > 0) || buffer.length > 3 * 1024 * 1024) {
              controller.abort(); 
              break;
          }
      }

      clearTimeout(timeoutTimer);

      if (resultName) {
          const decoded = decodeHtmlEntities(resultName);
          if (decoded === "YouTube") return null; // 排除官方預設標題
          
          return { name: decoded, subs: resultSubs };
      }
      return null;

    } catch (error) {
       if (timeoutTimer) clearTimeout(timeoutTimer);
       if (error.name !== 'AbortError') {
           // 非主動中斷的錯誤，增加錯誤計數
           this.errorCount++;
           Logger.info(`抓取失敗 (${handle}):`, error.message);
       }
       return null;
    }
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

  // 輔助函式：將訂閱數縮寫 (如 1.2M) 轉換為數值
  parseSubsString: function(str) {
      if (!str) return 0;
      let val = parseFloat(str.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return 0;
      
      const upper = str.toUpperCase();
      if (upper.includes('K')) val *= 1000;
      else if (upper.includes('M')) val *= 1000000;
      else if (upper.includes('B')) val *= 1000000000;
      else if (upper.includes('萬')) val *= 10000;
      else if (upper.includes('億')) val *= 100000000;
      
      return Math.floor(val);
  }
};