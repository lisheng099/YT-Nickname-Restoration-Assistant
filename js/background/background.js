// ===========================================================
// background.js - 核心服務
// 查詢順序：本機快取 -> 本機向 YouTube 查詢
// ===========================================================

try {
  importScripts(
    "../shared/config.js",
    "../shared/utils.js",
    "../libs/idb-keyval.js",
    "yt_parser.js",
    "bg_cache.js",
    "bg_fetcher.js",
    "../shared/notes_core.js",
    "bg_notes.js"
  );
} catch (e) {
  console.error("[Background] Script Import Error:", e);
}

// 版本更新時重置保險絲
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "update") {
    const { FUSE_FE_KEY, FUSE_BE_KEY } = AppConfig;
    const resetState = { status: "NORMAL", reason: null, timestamp: Date.now() };
    chrome.storage.local.set({ [FUSE_FE_KEY]: resetState, [FUSE_BE_KEY]: resetState });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "CACHE_GET") {
    handleCacheGet(request.handle, sendResponse);
    return true;
  }

  if (request.type === "CACHE_CLEAR") {
    BgCache.clear().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === "GET_CACHE_COUNT") {
    BgCache.getCount().then((count) => sendResponse({ count }));
    return true;
  }

  if (request.type === "CACHE_INVALIDATE") {
    BgCache.invalidateMemory(request.handles);
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "CACHE_CLEAR_MEM") {
    BgCache.memoryCache.clear();
    BgCache.pendingWrites.clear();
    if (BgCache.saveTimer) {
      clearTimeout(BgCache.saveTimer);
      BgCache.saveTimer = null;
    }
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "NOTES_LOOKUP") {
    BgNotes.lookup(request.ids).then((res) => sendResponse(res));
    return true;
  }

  if (request.type === "NOTES_SAVE") {
    BgNotes.save(request.identity, request.patch).then((res) => sendResponse(res));
    return true;
  }

  if (request.type === "NOTES_COUNT") {
    BgNotes.getCount().then((count) => sendResponse({ count }));
    return true;
  }

  if (request.type === "NOTES_CLEAR") {
    BgNotes.clear().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === "NOTES_LIST") {
    BgNotes.getAll().then((records) => sendResponse({ records }));
    return true;
  }

  if (request.type === "NOTES_DELETE") {
    BgNotes.remove(request.key).then((res) => sendResponse(res));
    return true;
  }

  if (request.type === "OPEN_MANAGER") {
    // 聊天室編輯視窗的「在觀眾資料頁查看」：開啟後台並帶入搜尋字
    const q = typeof request.query === "string" ? request.query.slice(0, 80) : "";
    const url = chrome.runtime.getURL("pages/manager/manager.html") + (q ? `?q=${encodeURIComponent(q)}` : "");
    chrome.tabs.create({ url });
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "NOTES_IMPORT") {
    BgNotes.importRecords(request.records).then((res) => sendResponse(res));
    return true;
  }

  if (request.type === "RESOLVE_CHANNEL_INFO") {
    const tabId = sender.tab ? sender.tab.id : null;
    handleResolveChannelInfo(request.handle, request.ttlMs, tabId).then((result) =>
      sendResponse(result)
    );
    return true;
  }

  if (request.type === "FETCH_CHANNEL_INFO") {
    const tabId = sender.tab ? sender.tab.id : null;
    resolveChannelInfo(request.handle, request.priority, request.refresh, tabId).then(
      (result) => sendResponse(result)
    );
    return true;
  }

  if (request.type === "RESET_BURST_QUOTA") {
    if (sender.tab) BgFetcher.resetQuota(sender.tab.id);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  BgFetcher.cleanupTab(tabId);
});

// 本機快取未命中時，直接由本機向 YouTube 查詢 (結果只寫入本機快取)
async function resolveChannelInfo(handle, priority, refresh, tabId) {
  return BgFetcher.fetch(handle, priority, refresh, tabId);
}

async function lookupCache(handle) {
  if (!handle) return null;

  const normKey =
    typeof BgCache.normalizeKey === "function"
      ? BgCache.normalizeKey(handle)
      : String(handle).trim().toLowerCase();
  if (BgCache.memoryCache.has(normKey)) {
    const data = BgCache.memoryCache.get(normKey);
    BgCache.memoryCache.delete(normKey);
    BgCache.memoryCache.set(normKey, data);
    return data;
  }
  if (BgCache.pendingWrites && BgCache.pendingWrites.has(normKey)) {
    return BgCache.pendingWrites.get(normKey);
  }

  const runningTask = BgFetcher.getRunningTask(handle);
  if (runningTask) {
    const result = await runningTask;
    if (result && result.success) {
      return { name: result.nameRaw, subs: result.subs, ts: Date.now() };
    }
    return null;
  }

  return (await BgCache.get(handle)) || null;
}

async function handleCacheGet(handle, sendResponse) {
  sendResponse(await lookupCache(handle));
}

async function handleResolveChannelInfo(handle, ttlMs, tabId) {
  if (!handle) return { success: false };
  const cached = await lookupCache(handle);
  if (cached && cached.name) {
    const ts = cached.ts || 0;
    const isExpired = typeof ttlMs === "number" && ttlMs > 0 ? Date.now() - ts > ttlMs : false;
    return {
      success: true,
      fromCache: true,
      name: cached.name,
      subs: cached.subs || 0,
      ts,
      isExpired,
    };
  }
  if (BgFetcher.fuseBackend.status === "TRIPPED") {
    return { success: false, error: "Fuse Tripped" };
  }
  const fetched = await resolveChannelInfo(handle, "high", false, tabId);
  if (fetched && fetched.success) {
    return {
      success: true,
      fromCache: false,
      nameRaw: fetched.nameRaw,
      subs: fetched.subs || 0,
      ts: Date.now(),
      isExpired: false,
    };
  }
  return { success: false, error: (fetched && fetched.error) || "Not resolved" };
}

BgCache.init();
