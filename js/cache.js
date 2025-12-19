// ===========================================================
// Cache.js - 快取代理 (Cache Proxy) [Content Script]
// 用途：作為前端與背景快取的溝通橋樑，不儲存實體資料。
// ===========================================================

const NameCache = {
  ttl: window.AppConfig.TTL,

  // 初始化：現在不需要載入大量資料了，只需通知完成
  load: function(callback) {
    if (callback) callback();
  },

  // 查詢資料 (非同步)
  // 改為回傳 Promise，向背景查詢
  get: async function(handle) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "CACHE_GET", handle: handle }, (response) => {
            if (!response) {
                resolve(null);
                return;
            }
            
            // 在前端計算是否過期
            const ts = response.ts || 0;
            const isExpired = (Date.now() - ts > this.ttl);

            resolve({ 
                name: response.name, 
                subs: response.subs || 0,
                isExpired: isExpired 
            });
        });
    });
  },

  // 更新資料
  // 發送訊息給背景，由背景處理寫入與排程
  set: function(handle, data) {
    if (!data || !data.name) return;
    
    chrome.runtime.sendMessage({ 
        type: "CACHE_SET", 
        handle: handle, 
        data: {
            name: data.name,
            subs: data.subs || 0
        } 
    });
  }
};