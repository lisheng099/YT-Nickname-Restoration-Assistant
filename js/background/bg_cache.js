// ===========================================================
// bg_cache.js - IndexedDB 背景快取管理器
// 用途：使用 IndexedDB 儲存海量資料，並實作寫入緩衝與 V1 遷移。
// ===========================================================

const BgCache = {
  memoryCache: new Map(),
  MAX_MEM_SIZE: 1000,

  // 寫入緩衝區
  pendingWrites: new Map(),
  saveTimer: null,
  SAVE_DELAY: 2000,
  BATCH_LIMIT: 50,
  isMigrating: false,

  init: async function () {
    await this.tryMigrateFromV1();
    this.syncSettingsAndPrune();
    Logger.info("[BgCache] IndexedDB (Buffered) 模式已啟動");
  },

  // === 設定同步與自動清理 ===
  syncSettingsAndPrune: function () {
    // 檢查 AppConfig 是否存在，避免在某些環境報錯
    if (typeof AppConfig === "undefined") return;
    const { SETTINGS_KEY, DEFAULT_DELETE_DAYS } = AppConfig;

    chrome.storage.local.get(SETTINGS_KEY, async (res) => {
      const settings = res[SETTINGS_KEY] || {};
      const deleteDays = settings.deleteDays || DEFAULT_DELETE_DAYS;

      // 執行清理 (刪除超過 DeleteDays 的資料)
      await this.pruneOldData(deleteDays);
    });
  },

  // === 刪除舊資料邏輯 ===
  pruneOldData: async function (days) {
    if (!days || days < 1) return;
    
    const ONE_DAY = daysToMs(1);
    const cutoffTime = Date.now() - days * ONE_DAY;
    let deleteCount = 0;

    try {
      // 取得所有資料並檢查時間戳記
      const entries = await idbKeyval.entries();
      const keysToDelete = [];

      for (const [key, val] of entries) {
        // 相容性檢查：如果是舊字串格式或沒有 ts，暫不刪除
        if (val && val.ts && val.ts < cutoffTime) {
          keysToDelete.push(key);
        }
      }

      if (keysToDelete.length > 0) {
        if (idbKeyval.delMany) {
          await idbKeyval.delMany(keysToDelete);
        } else {
          await Promise.all(keysToDelete.map((k) => idbKeyval.del(k)));
        }
        keysToDelete.forEach((k) => this.memoryCache.delete(k));
        deleteCount = keysToDelete.length;
        Logger.orange(
          `[AutoClean] 已自動清除 ${deleteCount} 筆超過 ${days} 天的舊資料`
        );
      }
    } catch (e) {
      Logger.red("[BgCache] AutoPrune Error:", e);
    }
  },

  // === 快速取得總數 (給 Popup 使用) ===
  getCount: async function () {
    try {
      // 讀取所有 Key 比讀取所有 Value 快很多
      const keys = await idbKeyval.keys();
      return keys.length;
    } catch (e) {
      Logger.red("[BgCache] getCount Error:", e);
      return 0;
    }
  },

  // === V1 資料遷移邏輯 ===
  tryMigrateFromV1: function () {
    return new Promise((resolve) => {
      // 檢查 AppConfig 是否存在
      if (typeof AppConfig === "undefined") {
        resolve();
        return;
      }
      
      const legacyKey = AppConfig.CACHE_KEY;
      chrome.storage.local.get(legacyKey, async (res) => {
        const oldData = res[legacyKey];
        if (!oldData || Object.keys(oldData).length === 0) {
          resolve();
          return;
        }

        Logger.orange(
          `[Migration] 發現舊版 V1 資料，準備遷移 ${
            Object.keys(oldData).length
          } 筆...`
        );
        this.isMigrating = true;

        const entries = Object.entries(oldData);
        const migrationPromises = [];

        for (const [handle, val] of entries) {
          let entry = val;
          if (typeof val === "string") entry = { name: val, subs: 0, ts: 0 };

          if (entry && entry.name) {
            if (!entry.ts) entry.ts = Date.now();
            migrationPromises.push(idbKeyval.set(handle, entry));
            this.setMemory(handle, entry); // 同步熱身
          }
        }

        try {
          await Promise.all(migrationPromises);
          Logger.green(`[Migration] 遷移成功！`);
          // 遷移成功後刪除舊資料
          chrome.storage.local.remove(legacyKey, () => {
            this.isMigrating = false;
            resolve();
          });
        } catch (err) {
          Logger.red(`[Migration] 遷移失敗，保留舊資料。`, err);
          this.isMigrating = false;
          resolve();
        }
      });
    });
  },

  // === 核心讀取邏輯 ===
  get: async function (handle) {
    if (!handle) return null;

    // 1. 查記憶體
    if (this.memoryCache.has(handle)) {
      const data = this.memoryCache.get(handle);
      
      // 先刪除，再重新加入
      // 這會讓這個 handle 從 Map 的原本位置移到「最後面」(變成最新)
      this.memoryCache.delete(handle);
      this.memoryCache.set(handle, data);
      
      return data;
    }

    // 2. 查緩衝區
    if (this.pendingWrites.has(handle)) {
      return this.pendingWrites.get(handle);
    }

    // 3. 查硬碟
    try {
      const diskData = await idbKeyval.get(handle);
      if (diskData) {
        // 動態計算過期狀態
        const userTTL = await this.getUserTTL();
        const now = Date.now();
        const isExpired = now - diskData.ts > userTTL;

        // 雖然原始資料只有 name/subs/ts，但回傳時需附帶 isExpired
        const result = {
            ...diskData,
            isExpired: isExpired
        };

        this.setMemory(handle, result);
        return result;
      }
    } catch (err) {
      Logger.red(`[Cache] IDB Read Error:`, err);
    }
    return null;
  },

  // === 寫入邏輯 ===
  set: function (handle, data) {
    if (!handle || !data) return;

    const cacheItem = {
      name: data.name,
      subs: data.subs || 0,
      ts: data.ts || Date.now(),
    };

    // 1. 更新記憶體
    this.setMemory(handle, cacheItem);

    // 2. 加入緩衝區
    this.pendingWrites.set(handle, cacheItem);

    // 3. 判斷寫入時機
    if (this.pendingWrites.size >= this.BATCH_LIMIT) {
      this.flushToDisk();
    } else {
      this.scheduleFlush();
    }
  },

  scheduleFlush: function () {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushToDisk(), this.SAVE_DELAY);
  },

  flushToDisk: async function () {
    if (this.pendingWrites.size === 0) return;

    const entries = Array.from(this.pendingWrites.entries());
    this.pendingWrites.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);

    try {
      if (idbKeyval.setMany) {
        await idbKeyval.setMany(entries);
      } else {
        await Promise.all(entries.map(([k, v]) => idbKeyval.set(k, v)));
      }

      if (AppConfig.DEBUG_MODE) {
        Logger.info(`[BgCache] 批次寫入 ${entries.length} 筆成功`);
      }
    } catch (err) {
      Logger.red(`[BgCache] 寫入失敗!`, err);
    }
  },

  setMemory: function (handle, item) {
    // 1. 如果已經存在，先刪除 (為了更新順序，也避免佔用 size 計算)
    if (this.memoryCache.has(handle)) {
      this.memoryCache.delete(handle);
    }
    // 2. 如果不存在且滿了，才踢掉最舊的
    else if (this.memoryCache.size >= this.MAX_MEM_SIZE) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    
    // 3. 寫入 (變成最新)
    this.memoryCache.set(handle, item);
  },

  delete: async function (handle) {
    this.memoryCache.delete(handle);
    this.pendingWrites.delete(handle);
    await idbKeyval.del(handle);
  },

  // 確保記憶體與硬碟皆被清空
  clear: async function () {
    // 1. 清空記憶體
    this.memoryCache.clear();
    
    // 2. 清空待寫入緩衝區
    this.pendingWrites.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // 3. 清空硬碟
    try {
      await idbKeyval.clear();
      if (typeof Logger !== "undefined") Logger.info("[BgCache] Database (Memory + IDB) cleared.");
    } catch (err) {
      console.error("[BgCache] Clear Failed:", err);
    }
  },

  // === 作廢記憶體快取 (用於 Manager 同步) ===
  invalidateMemory: function (handles) {
    if (!handles) return;
    const list = Array.isArray(handles) ? handles : [handles];
    list.forEach((h) => {
      this.memoryCache.delete(h);
      // 如果這個 handle 在緩衝區等待寫入，也一併移除，避免覆蓋掉 Manager 的操作
      this.pendingWrites.delete(h);
    });
    Logger.info(
      `[BgCache] 已作廢 ${list.length} 筆記憶體快取 (同步 Manager 操作)`
    );
  },

  // 輔助方法：取得使用者設定的 TTL
  getUserTTL: function () {
    return new Promise((resolve) => {
      const { SETTINGS_KEY, DEFAULT_TTL_DAYS } = AppConfig;
      chrome.storage.local.get(SETTINGS_KEY, (res) => {
        const settings = res[SETTINGS_KEY];
        let days = DEFAULT_TTL_DAYS;
        if (settings && settings.ttlDays) {
          days = parseInt(settings.ttlDays, 10);
        }
        resolve(daysToMs(days));
      });
    });
  },
};