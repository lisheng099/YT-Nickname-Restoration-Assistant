// ===========================================================
// notes_core.js - 觀眾筆記的共用核心 (純邏輯，主播版與觀眾版共用)
// 用途：暱稱 / 備註字串清理、主鍵規則 (頻道 ID 優先、@handle 備用)、
//       長度上限 (暱稱 / 備註)、以主鍵與 handle 雙向查找的索引、多筆修改的寫入 / 刪除清單，以及資料版本號通知。
// 說明：主播版的 viewer_model.js 與 bg_viewers.js、觀眾版的 bg_notes.js 都建立在這裡之上；
//       各版本自己的欄位 (標籤、評分、反應、雲端同步) 與合併規則留在各自檔案。
//       不依賴瀏覽器 API (寫入函式除外)，可在 Node 測試中直接 require。
// ===========================================================

(function (root) {
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

  // 兩個擴充共用的筆記長度上限，與 worker/app/extension_sync.py 的 LIMITS 一致
  // (worker/tests/test_sync_limits.py 會比對)。超過的部分在讀進索引與寫入時截掉。
  const LIMITS = {
    NICKNAME: 40,
    NOTE: 500,
    NOTES: 50,
  };

  /** 字串本身是頻道 ID 就回傳它，否則 null (要不要先 trim 由呼叫端決定)。 */
  function channelIdOf(s) {
    return typeof s === "string" && CHANNEL_ID.test(s) ? s : null;
  }

  /** @handle 的形狀：以 @ 開頭、2-61 字元、不含空白與 , / ? # & (fixtures/handle_cases.json)。 */
  function isHandleShape(h) {
    return typeof h === "string" && h.length >= 2 && h.length <= 61 && h[0] === "@" && !/[\s,/?#&]/.test(h);
  }

  /** 紀錄的主鍵：有頻道 ID 用頻道 ID，否則用 @handle；兩者都沒有時為 null。 */
  function recordKey(channelId, handle) {
    return channelId || handle || null;
  }

  /** 去頭尾空白並截斷；非字串一律當成空字串。 */
  function cleanText(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  /** 清理字串清單：去空白、截斷、去掉空字串與重複，最多 maxCount 筆 (保留原順序)。 */
  function uniqueTexts(list, maxLen, maxCount) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const item of list) {
      const s = cleanText(item, maxLen);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= maxCount) break;
    }
    return out;
  }

  /**
   * 紀錄索引：byKey 為 主鍵 -> 紀錄，byHandle 為 handle -> 主鍵。
   * 紀錄至少要有 key，可有 handle；同一個 handle 以最後放入的紀錄為準。
   */
  function createKeyIndex() {
    const byKey = new Map();
    const byHandle = new Map();
    return {
      byKey,
      byHandle,
      get size() {
        return byKey.size;
      },
      get: function (key) {
        return key ? byKey.get(key) || null : null;
      },
      put: function (rec) {
        byKey.set(rec.key, rec);
        if (rec.handle) byHandle.set(rec.handle, rec.key);
      },
      drop: function (rec) {
        if (!rec) return;
        byKey.delete(rec.key);
        if (rec.handle && byHandle.get(rec.handle) === rec.key) byHandle.delete(rec.handle);
      },
      /** 以 handle 找紀錄：先查 handle 對應的主鍵，再查以 handle 為主鍵的舊紀錄。 */
      findByHandle: function (handle) {
        if (!handle) return null;
        const mapped = byHandle.get(handle);
        if (mapped && byKey.has(mapped)) return byKey.get(mapped);
        return byKey.get(handle) || null;
      },
      /** 頻道 ID 優先，找不到再用 handle (傳入值須已正規化)。 */
      find: function (channelId, handle) {
        if (channelId && byKey.has(channelId)) return byKey.get(channelId);
        return this.findByHandle(handle);
      },
      clear: function () {
        byKey.clear();
        byHandle.clear();
      },
    };
  }

  /**
   * 收集多筆 patch 的結果 ({ saved, removedKeys })：同一主鍵以最後一次為準，
   * 先被刪又被存的主鍵只存不刪，反之亦然。
   */
  function createChangeSet() {
    const saved = new Map();
    const removed = new Set();
    return {
      saved,
      removed,
      add: function (res) {
        if (!res) return;
        for (const k of res.removedKeys || []) {
          removed.add(k);
          saved.delete(k);
        }
        if (res.saved) {
          saved.set(res.saved.key, res.saved);
          removed.delete(res.saved.key);
        }
      },
      get empty() {
        return saved.size === 0 && removed.size === 0;
      },
    };
  }

  /** 寫入 IndexedDB：先刪 removedKeys，再存 saved (以 key 為主鍵)。錯誤往外丟，由呼叫端記錄。 */
  async function writeChanges(idb, store, saved, removedKeys) {
    if (removedKeys && removedKeys.length) await idb.delMany(removedKeys, store);
    if (saved && saved.length) {
      const entries = saved.map((r) => [r.key, r]);
      if (idb.setMany) await idb.setMany(entries, store);
      else await Promise.all(entries.map(([k, v]) => idb.set(k, v, store)));
    }
  }

  /** 更新 storage 裡的資料版本號，讓開著的頁面知道筆記變了；storage 無法使用時略過。 */
  function bumpRev(revKey) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [revKey]: Date.now() });
      }
    } catch {
      // 各頁面在下次查詢時仍會取得最新資料
    }
  }

  const api = {
    LIMITS,
    CHANNEL_ID,
    channelIdOf,
    isHandleShape,
    recordKey,
    cleanText,
    uniqueTexts,
    createKeyIndex,
    createChangeSet,
    writeChanges,
    bumpRev,
  };
  root.NotesCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
