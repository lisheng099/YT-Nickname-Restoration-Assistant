// ===========================================================
// background.js - 核心服務
// ===========================================================

// 1. 引入依賴 (注意順序)
try {
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

// === 版本更新時自動重置保險絲 ===
// 當擴充功能更新 (Update) 時，假設問題已修復，自動將保險絲重置為 NORMAL
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") {
    const { FUSE_FE_KEY, FUSE_BE_KEY } = AppConfig;
    const resetState = { status: "NORMAL", reason: null, timestamp: Date.now() };

    chrome.storage.local.set(
      {
        [FUSE_FE_KEY]: resetState,
        [FUSE_BE_KEY]: resetState,
      },
      () => {
        console.log(
          `[Background] Extension updated to v${chrome.runtime.getManifest().version}. Fuses have been reset.`
        );
      }
    );
  }
});

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

  // === 強制讓 Memory Cache 失效 (同步 Manager 操作) ===
  if (request.type === "CACHE_INVALIDATE") {
    BgCache.invalidateMemory(request.handles);
    sendResponse({ success: true });
    return false;
  }

  // === 清空 Memory Cache ===
  if (request.type === "CACHE_CLEAR_MEM") {
    BgCache.clear(); // 這裡我們直接呼叫 clear，因為 clear 也包含了清空 memory
    sendResponse({ success: true });
    return false;
  }

  // === Popup 請求總數 ===
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

// === 監聽分頁關閉事件 (防止 Memory Leak) ===
chrome.tabs.onRemoved.addListener((tabId) => {
  BgFetcher.cleanupTab(tabId);
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
        isExpired: false,
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

  // (4) 無資料 -> 回傳 null 引發後台抓取
  sendResponse(null);
}

// 4. 初始化
BgCache.init();
