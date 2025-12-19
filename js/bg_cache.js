// ===========================================================
// bg_cache.js - 背景快取管理器 (Background Cache Manager)
// 用途：在 Service Worker 中統一管理快取資料，避免每個分頁重複載入。
// ===========================================================

const BgCache = {
  data: {},
  isLoaded: false,
  dirtySet: new Set(),
  saveTimer: null,
  SAVE_DELAY: 2000, // 寫入防抖延遲
  LOCK_NAME: "yt_realname_storage_lock", // 與 manager.js 共用鎖定名稱

  // 初始化
  init: function() {
    this.loadFromDisk();

    // 監聽來自 Manager 頁面的外部變更，保持同步
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[AppConfig.CACHE_KEY]) {
        this.loadFromDisk();
      }
    });
  },

  // 從硬碟載入
  loadFromDisk: function() {
    chrome.storage.local.get(AppConfig.CACHE_KEY, (res) => {
        const raw = res[AppConfig.CACHE_KEY] || {};
        
        const cleanData = {};
        for (const [key, val] of Object.entries(raw)) {
            let entry = val;

            // 相容舊版或匯入的「純字串」格式
            if (typeof val === "string") {
                entry = { 
                    name: val, 
                    subs: 0, 
                    ts: 0 
                };
            }

            // 確保資料有效且包含 name 欄位
            if (entry && entry.name) {
                cleanData[key] = entry;
            }
        }

        // 防止正在寫入的資料被硬碟舊資料覆蓋
        // 如果目前有尚未寫入硬碟的資料 (Dirty Data)，強制將記憶體中的最新版本合併回去
        this.dirtySet.forEach(handle => {
             // 必須確認 this.data[handle] 存在 (從當前記憶體讀取)
             if (this.data[handle]) {
                 cleanData[handle] = this.data[handle];
             }
        });

        this.data = cleanData;
        this.isLoaded = true;
        
        if (AppConfig.DEBUG_MODE) {
            console.log(`[BgCache] 快取已同步，共 ${Object.keys(this.data).length} 筆 (含 ${this.dirtySet.size} 筆未存檔)`);
        }
    });
  },

  // 查詢資料
  get: function(handle) {
    return this.data[handle] || null;
  },

  // 更新資料 (暫存於記憶體並排程寫入)
  set: function(handle, info) {
    if (!handle || !info) return;
    
    // 更新記憶體
    this.data[handle] = { 
        name: info.name, 
        subs: info.subs || 0, 
        ts: Date.now() 
    };
    
    this.dirtySet.add(handle);
    this.scheduleSave();
  },

  // 排程存檔
  scheduleSave: function() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveToDisk(), this.SAVE_DELAY);
  },

  // 寫入硬碟 (使用 Web Locks API 防止與 Manager 衝突)
  saveToDisk: function() {
    if (this.dirtySet.size === 0) return;

    // 複製目前要存的 keys，避免異步執行時 dirtySet 變動
    const keysToSave = Array.from(this.dirtySet);
    
    // 請求鎖定
    navigator.locks.request(this.LOCK_NAME, async () => {
        return new Promise((resolve) => {
            // 讀取最新 Storage (避免覆蓋 Manager 的刪除操作)
            chrome.storage.local.get(AppConfig.CACHE_KEY, (res) => {
                const diskData = res[AppConfig.CACHE_KEY] || {};
                
                // 合併變更
                keysToSave.forEach(key => {
                    // 再次確認記憶體中是否有資料
                    if (this.data[key]) {
                        diskData[key] = this.data[key];
                    }
                });

                // 寫回
                chrome.storage.local.set({ [AppConfig.CACHE_KEY]: diskData }, () => {
                    // 清除已儲存的標記
                    keysToSave.forEach(k => this.dirtySet.delete(k));
                    if (AppConfig.DEBUG_MODE) {
                        console.log(`[BgCache] 已同步 ${keysToSave.length} 筆資料至硬碟`);
                    }
                    resolve();
                });
            });
        });
    }).catch(err => console.error("[BgCache] Save Error:", err));
  }
};

// 監聽訊息
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "CACHE_GET") {
    // 如果尚未載入完成，嘗試載入後再回傳
    if (!BgCache.isLoaded) {
       chrome.storage.local.get(AppConfig.CACHE_KEY, (res) => {
           const raw = res[AppConfig.CACHE_KEY] || {};
           // 緊急載入，不覆蓋既有資料，僅作填充
           if (Object.keys(BgCache.data).length === 0) {
               BgCache.data = raw;
           }
           BgCache.isLoaded = true;
           sendResponse(BgCache.get(req.handle));
       });
       return true; // 保持通道開啟
    }
    sendResponse(BgCache.get(req.handle));
    return false; // 同步回傳
  } 
  
  if (req.type === "CACHE_SET") {
    BgCache.set(req.handle, req.data);
    sendResponse({ success: true });
    return false;
  }
});

BgCache.init();