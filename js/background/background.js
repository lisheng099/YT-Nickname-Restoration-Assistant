// ===========================================================
// background.js - 核心服務 (Controller - IDB版)
// ===========================================================

// 1. 引入依賴 (注意順序)
try {
  // [修正] importScripts 順序非常重要，必須依照依賴關係排列
  importScripts(
    "../shared/config.js", // 1. 基礎設定 (AppConfig) 必須最先載入
    "../shared/utils.js", // 2. 工具函式 (Logger) 依賴 Config
    "../libs/idb-keyval.js", // 3. 第三方 IndexedDB 庫
    "yt_parser.js", // 4. 解析器
    "bg_cache.js", // 5. 快取管理器 (依賴 Config, Utils, IDB)
    "bg_fetcher.js" // 6. 爬蟲管理器 (依賴 Config, Utils, Cache, Parser)
  );
} catch (e) {
  console.error("[Background] Script Import Error:", e);
}

// 2. 監聽訊息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // === 快取查詢 (Async) ===
  if (request.type === "CACHE_GET") {
    handleCacheGet(request.handle, sendResponse);
    return true; // 保持通道開啟
  }

  // === 寫入快取 (手動) ===
  if (request.type === "CACHE_SET") {
    BgCache.set(request.handle, request.data);
    sendResponse({ success: true });
    return false;
  }

  // === [新增] Popup 請求總數 ===
  if (request.type === "GET_CACHE_COUNT") {
    BgCache.getCount().then((count) => {
      sendResponse({ count: count });
    });
    return true; // 保持通道開啟以進行非同步回應
  }

  // === 抓取請求 ===
  if (request.type === "FETCH_CHANNEL_INFO") {
    const tabId = sender.tab ? sender.tab.id : null;
    BgFetcher.fetch(
      request.handle,
      request.priority,
      request.refresh,
      tabId
    ).then((result) => sendResponse(result));
    return true;
  }

  if (request.type === "RESET_BURST_QUOTA") {
    if (sender.tab) BgFetcher.resetQuota(sender.tab.id);
  }
});

// 3. 核心查詢順序控制
async function handleCacheGet(handle, sendResponse) {
  if (!handle) {
    sendResponse(null);
    return;
  }

  // (1) 記憶體 (Memory Cache)
  if (BgCache.memoryCache.has(handle)) {
    sendResponse(BgCache.memoryCache.get(handle));
    return;
  }

  // (2) 爬蟲佇列 (Request Coalescing)
  const runningTask = BgFetcher.getRunningTask(handle);
  if (runningTask) {
    const result = await runningTask;
    if (result && result.success) {
      sendResponse({
        name: result.nameRaw,
        subs: result.subs,
        isExpired: false, // 剛抓的一定是新的
      });
    } else {
      sendResponse(null);
    }
    return;
  }

  // (3) 硬碟 (IndexedDB via Cache Manager)
  const diskData = await BgCache.get(handle);
  if (diskData) {
    sendResponse(diskData);
    return;
  }

  // (4) 無資料 -> 回傳 null 引發前台抓取
  sendResponse(null);
}

// 4. 初始化
BgCache.init();
