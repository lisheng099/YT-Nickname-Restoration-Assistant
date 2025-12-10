// ===========================================================
// Cache.js - 快取資料存取層 (Data Access Layer)
// 用途：管理頻道名稱資料的讀取、寫入與持久化。
// ===========================================================

const NameCache = {
  // 記憶體快取
  data: {}, 
  
  // 儲存設定
  key: window.AppConfig.CACHE_KEY,
  ttl: window.AppConfig.TTL,
  
  _saveTimer: null,
  _dirtySet: new Set(), 
  SAVE_DELAY: 1000, 
  
  // 鎖定名稱 (用於 navigator.locks)
  LOCK_NAME: "yt_realname_storage_lock",

  // 初始化：從 Chrome Storage 載入資料至記憶體
  load: function(callback) {
    try {
        if (!chrome || !chrome.storage || !chrome.storage.local) { 
            callback && callback(); 
            return; 
        }

        chrome.storage.local.get(this.key, (res) => {
          if (chrome.runtime.lastError) {
             console.log("[NameCache] 環境已失效，略過載入");
             return;
          }

          const raw = res[this.key];
          const safeRaw = (raw && typeof raw === "object") ? raw : {};
          const pruned = {}; 
          let validCount = 0;
    
          for (const [handle, entry] of Object.entries(safeRaw)) {
            if (!entry) continue;
            const name = entry.name;
            if (!name) continue;
            
            pruned[handle] = { 
                name, 
                subs: entry.subs || 0, 
                ts: entry.ts || 0 
            };
            validCount++;
          }
    
          this.data = pruned;
          this._dirtySet.clear(); 
          
          Logger.green(`快取載入完成，共 ${validCount} 筆資料`);
          
          window.addEventListener("beforeunload", () => {
              this.saveToDisk();
          });
    
          if (callback) callback();
        });
    } catch (e) {
        console.log("[NameCache] 載入過程發生例外", e);
    }
  },

  // 新增或更新資料
  set: function(handle, data) {
    if (!data || !data.name) return;
    
    const now = Date.now();
    this.data[handle] = { 
        name: data.name, 
        subs: data.subs || 0, 
        ts: now 
    };
    
    this._dirtySet.add(handle);
    this.scheduleSave();
  },

  // 讀取資料
  get: function(handle) {
    const entry = this.data[handle];
    if (!entry) return null; 
    
    const ts = entry.ts || 0;
    const isExpired = (Date.now() - ts > this.ttl);

    return { 
        name: entry.name, 
        subs: entry.subs || 0,
        isExpired: isExpired 
    };
  },

  // 排程存檔
  scheduleSave: function() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveToDisk();
    }, this.SAVE_DELAY);
  },

  // === 核心邏輯：持久化寫入 (Persistence) ===
  saveToDisk: function() {
    if (this._dirtySet.size === 0) return;
    
    try {
        if (!chrome?.storage?.local) return;
    } catch (e) { return; }

    if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
    }

    const keysToSave = Array.from(this._dirtySet);
    Logger.info(`[Cache] 準備同步 ${keysToSave.length} 筆變更 (等待鎖定)...`);

    // 使用 Web Locks API 取得獨佔鎖
    // 當 Lock 被取得時，其他分頁若嘗試執行此段代碼會自動排隊等待，直到鎖被釋放。
    navigator.locks.request(this.LOCK_NAME, async () => {
        return new Promise((resolve) => {
            // 步驟 1: 在鎖定保護下，讀取最新的 Storage
            chrome.storage.local.get(this.key, (res) => {
                if (chrome.runtime.lastError) {
                    resolve();
                    return;
                }

                const diskData = res[this.key] || {};
                let hasChanges = false;
                
                // 步驟 2: 合併變更
                keysToSave.forEach(key => {
                    if (this.data[key]) {
                        diskData[key] = this.data[key];
                        hasChanges = true;
                    }
                });

                if (!hasChanges) {
                    resolve();
                    return;
                }

                // 步驟 3: 寫回 Storage
                chrome.storage.local.set({ [this.key]: diskData }, () => {
                    if (!chrome.runtime.lastError) {
                        keysToSave.forEach(k => this._dirtySet.delete(k));
                        Logger.green(`[Cache] 同步完成 (已釋放鎖定)`);
                    }
                    resolve(); // 釋放鎖
                });
            });
        });
    }).catch(err => {
        Logger.red(`[Cache] 存檔鎖定失敗:`, err);
    });
  }
};

// === 跨分頁資料同步 ===
if (chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[window.AppConfig.CACHE_KEY]) {
      const newValue = changes[window.AppConfig.CACHE_KEY].newValue;
      
      if (!newValue) {
        NameCache.data = {};
        NameCache._dirtySet.clear();
        return;
      }

      const mergedData = { ...newValue };
      NameCache._dirtySet.forEach(key => {
          if (NameCache.data[key]) {
              mergedData[key] = NameCache.data[key];
          }
      });
      NameCache.data = mergedData;
    }
  });
}