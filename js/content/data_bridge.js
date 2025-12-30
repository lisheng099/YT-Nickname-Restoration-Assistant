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
            this.fuseBackendStatus = changes[FUSE_BE_KEY].newValue.status;
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

  // === 核心方法：獲取資料 ===
  // 參數：
  // - handle: 要查詢的 ID
  // - callback: 當拿到資料時執行的函式 (data) => void
  getData: async function (handle, callback) {
    if (!handle) return;

    // 1. 先向背景查詢快取 (Cache First)
    const cachedData = await this.queryCache(handle);

    // 2. 判斷資料狀態
    if (cachedData) {
      // [情況 A] 快取命中且有效
      if (!cachedData.isExpired) {
        callback(cachedData);
        return;
      }

      // [情況 B] 快取命中但已過期
      // 這裡無論後端保險絲狀態如何，都先回傳快取資料 (確保畫面有內容)
      callback(cachedData);
      
      // 只有當「後端保險絲正常」時，才發起背景更新
      // 如果後端熔斷，就只顯示舊資料，不發送網路請求，避免進一步錯誤
      if (this.fuseBackendStatus === "NORMAL") {
        this.fetchBackground(handle, "low", callback); // 低優先級更新
      }
    } else {
      // [情況 C] 無快取
      // 如果後端熔斷，無法抓取也無快取，只好放棄
      if (this.fuseBackendStatus === "TRIPPED") {
        callback(null);
        return;
      }
      
      // 只有後端正常時才發起高優先級請求
      this.fetchBackground(handle, "high", callback);
    }
  },

  // === 內部：查詢快取 ===
  queryCache: function (handle) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CACHE_GET", handle: handle },
        (response) => {
          if (!response) {
            resolve(null);
            return;
          }
          // 計算過期狀態
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
        // 錯誤處理
        if (chrome.runtime.lastError || !response || !response.success) {
          // 網路請求失敗，默默不做事 (如果是 expired update)
          // 或者回傳 null (如果是 high priority)
          if (typeof callback === "function" && !isExpiredUpdate) {
            callback(null);
          }
          return;
        }

        // 資料解碼
        let finalName = response.nameRaw;
        if (typeof decodeHtmlEntities === "function") {
          finalName = decodeHtmlEntities(finalName);
        }

        if (finalName === "YouTube") return;

        // 回傳最新資料 (此時肯定不過期)
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