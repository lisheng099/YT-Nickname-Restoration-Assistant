// ===========================================================
// bg_cache.js - IndexedDB 背景快取管理器 (Buffered Write 版)
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
    Logger.info("[BgCache] IndexedDB (Buffered) 模式已啟動");
  },

  // === [新增] 快速取得總數 (給 Popup 使用) ===
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
      return this.memoryCache.get(handle);
    }

    // 2. 查緩衝區
    if (this.pendingWrites.has(handle)) {
      return this.pendingWrites.get(handle);
    }

    // 3. 查硬碟
    try {
      const diskData = await idbKeyval.get(handle);
      if (diskData) {
        this.setMemory(handle, diskData);
        return diskData;
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
    if (this.memoryCache.size >= this.MAX_MEM_SIZE) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(handle, item);
  },

  delete: async function (handle) {
    this.memoryCache.delete(handle);
    this.pendingWrites.delete(handle);
    await idbKeyval.del(handle);
  },

  clear: async function () {
    this.memoryCache.clear();
    this.pendingWrites.clear();
    await idbKeyval.clear();
  },
};
