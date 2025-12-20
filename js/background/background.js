// ===========================================================
// background.js - 背景服務入口 (V2.1)
// 用途：處理擴充功能的訊息路由，將工作委派給 BgFetcher 與 BgCache。
// ===========================================================

try {
    // [新增] 加入 utils.js 以啟用 Logger
    importScripts(
        '../shared/config.js', 
        '../shared/utils.js',
        'yt_parser.js',
        'bg_cache.js', 
        'bg_fetcher.js' 
    );
    // Logger 載入後，可以試著印一行確認
    if (typeof Logger !== "undefined") Logger.info("Background Service Worker 啟動完成");
} catch (e) {
    console.error("[Background] Script Import Error:", e);
}

// 訊息監聽器
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  if (request.type === "FETCH_CHANNEL_INFO") {
    const priority = request.priority || 'high';
    const forceRefresh = request.refresh || false; 
    BgFetcher.fetch(request.handle, priority, forceRefresh).then(sendResponse);
    return true; 
  }

  if (request.type === "CACHE_GET") {
      if (!BgCache.isLoaded) {
           chrome.storage.local.get(AppConfig.CACHE_KEY, (res) => {
               const raw = res[AppConfig.CACHE_KEY] || {};
               if (Object.keys(BgCache.data).length === 0) BgCache.data = raw;
               BgCache.isLoaded = true;
               sendResponse(BgCache.get(request.handle));
           });
           return true; 
      }
      sendResponse(BgCache.get(request.handle));
      return false;
  }
  
  if (request.type === "CACHE_SET") {
    BgCache.set(request.handle, request.data);
    sendResponse({ success: true });
    return false;
  }
});