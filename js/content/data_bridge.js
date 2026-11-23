// ===========================================================
// data_bridge.js - 前台數據橋樑
// 用途：前台頁面與背景服務的單一窗口。
// 職責：整合快取查詢與網路請求，提供統一的 getData 介面給 Scanner 使用。
// ===========================================================

const DataBridge = {
  // 讓 Scanner 知道是否過期 (用於決定 UI 樣式)
  currentTTL: daysToMs(window.AppConfig.DEFAULT_TTL_DAYS),
  // 需要知道後端保險絲狀態，因為這決定了是否能發送網路請求
  fuseBackendStatus: "NORMAL",

  // 頁內記憶體快取與進行中請求去重：同一人連續發言不重複發 IPC
  MAX_PAGE_CACHE: 2000,
  pageCache: new Map(), // normHandle -> { name, subs, ts }
  inFlight: new Map(), // normHandle -> [callback, ...]
  refreshing: new Map(), // normHandle -> [callback, ...]

  init: function () {
    this.syncSettings();
  },

  syncSettings: function () {
    const { SETTINGS_KEY, FUSE_BE_KEY } = window.AppConfig;

    chrome.storage.local.get([SETTINGS_KEY, FUSE_BE_KEY], (res) => {
      this.updateTTL(res[SETTINGS_KEY]);
      if (res[FUSE_BE_KEY]) this.fuseBackendStatus = res[FUSE_BE_KEY].status;
    });

    // 監聽變化
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes[SETTINGS_KEY]) {
          this.updateTTL(changes[SETTINGS_KEY].newValue);
        }
        // 監聽後端保險絲
        if (changes[FUSE_BE_KEY]) {
          this.fuseBackendStatus =
            changes[FUSE_BE_KEY].newValue?.status || "NORMAL";
        }
      }
    });
  },

  updateTTL: function (settings) {
    const days =
      settings && settings.ttlDays
        ? settings.ttlDays
        : window.AppConfig.DEFAULT_TTL_DAYS;
    this.currentTTL = daysToMs(days);
  },

  normalizeKey: function (handle) {
    return String(handle || "").trim().toLowerCase();
  },

  rememberPageCache: function (key, entry) {
    if (this.pageCache.has(key)) this.pageCache.delete(key);
    else if (this.pageCache.size >= this.MAX_PAGE_CACHE) {
      this.pageCache.delete(this.pageCache.keys().next().value);
    }
    this.pageCache.set(key, entry);
  },

  decodeName: function (raw) {
    let finalName = raw;
    if (typeof decodeHtmlEntities === "function") {
      finalName = decodeHtmlEntities(finalName);
    }
    return finalName;
  },

  // === 核心方法：獲取資料 ===
  // 參數：
  // - handle: 要查詢的 ID
  // - callback: 當拿到資料時執行的函式 (data) => void
  getData: function (handle, callback) {
    if (!handle || typeof callback !== "function") return;
    const key = this.normalizeKey(handle);
    if (!key) return;

    // 1. 頁內快取直接命中 (0 IPC)
    const local = this.pageCache.get(key);
    if (local) {
      const isExpired = Date.now() - (local.ts || 0) > this.currentTTL;
      callback({ name: local.name, subs: local.subs || 0, isExpired });
      if (isExpired && this.fuseBackendStatus === "NORMAL") {
        this.scheduleRefresh(handle, key, callback);
      }
      return;
    }

    // 2. 同一個 handle 正在查詢中：合併等待，避免重複發送 IPC
    if (this.inFlight.has(key)) {
      this.inFlight.get(key).push(callback);
      return;
    }

    this.inFlight.set(key, [callback]);

    try {
      chrome.runtime.sendMessage(
        {
          type: "RESOLVE_CHANNEL_INFO",
          handle: handle,
          ttlMs: this.currentTTL,
        },
        (response) => {
          const waiters = this.inFlight.get(key) || [];
          this.inFlight.delete(key);

          if (chrome.runtime.lastError || !response || !response.success) {
            waiters.forEach((cb) => cb(null));
            return;
          }

          const rawName = response.fromCache ? response.name : response.nameRaw;
          const finalName = response.fromCache ? rawName : this.decodeName(rawName);
          if (!finalName || finalName === "YouTube") {
            waiters.forEach((cb) => cb(null));
            return;
          }

          const ts = response.ts || Date.now();
          const subs = response.subs || 0;
          const isExpired = response.isExpired === true;

          this.rememberPageCache(key, { name: finalName, subs, ts });
          const payload = { name: finalName, subs, isExpired };
          waiters.forEach((cb) => cb(payload));

          if (isExpired && this.fuseBackendStatus === "NORMAL") {
            waiters.forEach((cb) => this.scheduleRefresh(handle, key, cb));
          }
        }
      );
    } catch (e) {
      const waiters = this.inFlight.get(key) || [];
      this.inFlight.delete(key);
      waiters.forEach((cb) => cb(null));
    }
  },

  // 過期資料的背景低優先級更新（同 handle 去重）
  scheduleRefresh: function (handle, key, callback) {
    if (this.refreshing.has(key)) {
      this.refreshing.get(key).push(callback);
      return;
    }
    this.refreshing.set(key, [callback]);
    this.fetchBackground(handle, "low", (fresh) => {
      const waiters = this.refreshing.get(key) || [];
      this.refreshing.delete(key);
      if (!fresh) return;
      this.rememberPageCache(key, {
        name: fresh.name,
        subs: fresh.subs || 0,
        ts: Date.now(),
      });
      waiters.forEach((cb) => cb(fresh));
    });
  },

  // === 內部：查詢快取 (保留給外部/舊呼叫相容) ===
  queryCache: function (handle) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CACHE_GET", handle: handle },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
            return;
          }
          const ts = response.ts || 0;
          const isExpired = Date.now() - ts > this.currentTTL;

          resolve({
            name: response.name,
            subs: response.subs || 0,
            isExpired: isExpired,
          });
        }
      );
    });
  },

  // 找到 fetchBackground 方法
  fetchBackground: function (handle, priority, callback) {
    const isExpiredUpdate = priority === "low";

    chrome.runtime.sendMessage(
      {
        type: "FETCH_CHANNEL_INFO",
        handle: handle,
        priority: priority,
        refresh: isExpiredUpdate,
      },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          if (typeof callback === "function") {
            callback(null);
          }
          return;
        }

        const finalName = this.decodeName(response.nameRaw);
        if (!finalName || finalName === "YouTube") {
          if (typeof callback === "function") callback(null);
          return;
        }

        callback({
          name: finalName,
          subs: response.subs || 0,
          isExpired: false,
        });
      }
    );
  },
};
DataBridge.init();