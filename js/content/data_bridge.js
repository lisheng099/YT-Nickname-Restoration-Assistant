// ===========================================================
// data_bridge.js - 前台數據橋樑
// 用途：前台頁面與背景服務的單一窗口。
// 職責：整合快取查詢與網路請求，提供統一的 getData 介面給 Scanner 使用。
// ===========================================================

const DataBridge = {
  // 讓 Scanner 知道是否過期 (用於決定 UI 樣式)
  TTL: window.AppConfig.TTL,

  // === 核心方法：獲取資料 ===
  // 參數：
  // - handle: 要查詢的 ID
  // - callback: 當拿到資料時執行的函式 (data) => void
  getData: async function (handle, callback) {
    if (!handle) return;

    // 1. 先向背景查詢快取 (Cache First)
    // 注意：這裡使用 Promise 是為了讓程式碼更乾淨，背景通訊其實是異步的
    const cachedData = await this.queryCache(handle);

    // 2. 判斷資料狀態
    if (cachedData) {
      // [情況 A] 快取命中且有效
      if (!cachedData.isExpired) {
        callback(cachedData);
        return;
      }

      // [情況 B] 快取命中但已過期 -> 先顯示舊資料 (UX 優化)，同時背景更新
      callback(cachedData);
      this.fetchBackground(handle, "low", callback); // 低優先級更新
    } else {
      // [情況 C] 無快取 -> 直接發起高優先級請求
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
          const isExpired = Date.now() - ts > this.TTL;

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
          // 即使失敗也可以回傳 null，讓 UI 決定是否要保持原樣
          // callback(null); // 視需求決定是否要 callback null
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
