// ===========================================================
// bg_viewers.js - 觀眾筆記儲存 (背景)
// 用途：以獨立的 IndexedDB 資料庫保存標籤、備註、評分與自訂暱稱。
// 說明：背景服務是唯一的寫入者；前台與管理頁透過訊息讀寫，
//       每次寫入後更新 storage 的版本號，讓各頁面得知資料已變動。
// ===========================================================

const BgViewers = {
  DB_NAME: "yt_viewer_notes_db",
  STORE_NAME: "viewers",
  TAGS_KEY: "__tags__",
  REACTION_DEFS_KEY: "__reaction_defs__",
  REV_KEY: "yt_viewer_notes_rev",

  index: new ViewerModel.ViewerIndex(),
  store: null,
  readyPromise: null,

  ready: function () {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        try {
          this.store = idbKeyval.createStore(this.DB_NAME, this.STORE_NAME);
          const entries = await idbKeyval.entries(this.store);
          let tags = [];
          let reactionDefs = null;
          const records = [];
          for (const [key, val] of entries) {
            if (key === this.TAGS_KEY) tags = val;
            else if (key === this.REACTION_DEFS_KEY) reactionDefs = val;
            else records.push(val);
          }
          this.index.load(records, tags, reactionDefs);
        } catch (e) {
          Logger.red("[BgViewers] 載入失敗:", e);
        }
      })();
    }
    return this.readyPromise;
  },

  bumpRev: function () {
    try {
      chrome.storage.local.set({ [this.REV_KEY]: Date.now() });
    } catch (e) {
      // storage 無法使用時，各頁面在下次查詢時仍會取得最新資料
    }
  },

  persist: async function (saved, removedKeys) {
    try {
      if (removedKeys && removedKeys.length) await idbKeyval.delMany(removedKeys, this.store);
      if (saved && saved.length) {
        await idbKeyval.setMany(
          saved.map((r) => [r.key, r]),
          this.store
        );
      }
    } catch (e) {
      Logger.red("[BgViewers] 寫入失敗:", e);
    }
  },

  // 頁面上讀不到頻道 ID 時，改用暱稱快取裡抓取頻道頁面時記下的 ID
  withCachedChannelId: function (identity) {
    if (!identity || identity.channelId || !identity.rawHandle) return identity;
    const cached = typeof BgCache !== "undefined" ? BgCache.memoryCache.get(identity.rawHandle) : null;
    return cached && cached.cid ? { ...identity, channelId: cached.cid } : identity;
  },

  lookup: async function (ids) {
    await this.ready();
    const list = Array.isArray(ids) ? ids.slice(0, 200) : [];
    return {
      records: list.map((id) => this.index.find(this.withCachedChannelId(id))),
      tags: this.index.tags,
      reactionDefs: this.index.reactionDefs,
    };
  },

  patch: async function (identity, patch) {
    await this.ready();
    const res = this.index.patch(this.withCachedChannelId(identity), patch);
    await this.persist(res.saved ? [res.saved] : [], res.removedKeys);
    this.bumpRev();
    return res.record;
  },

  // 一次套用多筆修改，只通知一次
  patchMany: async function (items) {
    await this.ready();
    const saved = new Map();
    const removed = new Set();
    for (const item of items || []) {
      const res = this.index.patch(item.identity, item.patch);
      res.removedKeys.forEach((k) => {
        removed.add(k);
        saved.delete(k);
      });
      if (res.saved) {
        saved.set(res.saved.key, res.saved);
        removed.delete(res.saved.key);
      }
    }
    await this.persist([...saved.values()], [...removed]);
    if (saved.size || removed.size) this.bumpRev();
    return saved.size;
  },

  remove: async function (key) {
    await this.ready();
    if (this.index.remove(key)) {
      await this.persist([], [key]);
      this.bumpRev();
    }
  },

  setTags: async function (defs) {
    await this.ready();
    const res = this.index.setTags(defs);
    try {
      await idbKeyval.set(this.TAGS_KEY, this.index.tags, this.store);
    } catch (e) {
      Logger.red("[BgViewers] 標籤寫入失敗:", e);
    }
    await this.persist(res.changed, res.removedKeys);
    this.bumpRev();
    return this.index.tags;
  },

  setReactionDefs: async function (defs) {
    await this.ready();
    this.index.setReactionDefs(defs);
    try {
      await idbKeyval.set(this.REACTION_DEFS_KEY, this.index.reactionDefs, this.store);
    } catch (e) {
      Logger.red("[BgViewers] 反應項目寫入失敗:", e);
    }
    this.bumpRev();
    return this.index.reactionDefs;
  },

  // 表情次數最高的觀眾 (聊天室小榜用)
  top: async function (limit) {
    await this.ready();
    return this.index
      .list()
      .filter((r) => ViewerModel.totalReactions(r) > 0 || r.score > 0)
      .sort(
        (a, b) =>
          ViewerModel.totalReactions(b) - ViewerModel.totalReactions(a) ||
          b.score - a.score ||
          b.updatedAt - a.updatedAt
      )
      .slice(0, Math.max(1, Math.min(50, limit || 10)));
  },

  list: async function () {
    await this.ready();
    return { viewers: this.index.list(), tags: this.index.tags, reactionDefs: this.index.reactionDefs };
  },

  exportData: async function () {
    await this.ready();
    return this.index.exportData();
  },

  importData: async function (data, mode) {
    await this.ready();
    const result = this.index.importData(data, mode);
    await idbKeyval.clear(this.store);
    await idbKeyval.set(this.TAGS_KEY, this.index.tags, this.store);
    await idbKeyval.set(this.REACTION_DEFS_KEY, this.index.reactionDefs, this.store);
    await this.persist(this.index.list(), []);
    this.bumpRev();
    return result;
  },

  clear: async function () {
    await this.ready();
    this.index.load([], [], this.index.reactionDefs);
    await idbKeyval.clear(this.store);
    await idbKeyval.set(this.REACTION_DEFS_KEY, this.index.reactionDefs, this.store);
    this.bumpRev();
  },

  // 訊息入口；回傳 true 表示已接手並會非同步回應
  handleMessage: function (request, sendResponse) {
    const run = (promise) => {
      promise.then(
        (data) => sendResponse({ ok: true, data }),
        (err) => sendResponse({ ok: false, error: (err && err.message) || "error" })
      );
      return true;
    };
    switch (request.type) {
      case "VN_LOOKUP":
        return run(this.lookup(request.ids));
      case "VN_PATCH":
        return run(this.patch(request.identity, request.patch));
      case "VN_REMOVE":
        return run(this.remove(request.key));
      case "VN_TAGS_SET":
        return run(this.setTags(request.tags));
      case "VN_REACTION_DEFS_SET":
        return run(this.setReactionDefs(request.reactionDefs));
      case "VN_TOP":
        return run(this.top(request.limit));
      case "VN_LIST":
        return run(this.list());
      case "VN_EXPORT":
        return run(this.exportData());
      case "VN_IMPORT":
        return run(this.importData(request.data, request.mode));
      case "VN_CLEAR":
        return run(this.clear());
      default:
        return false;
    }
  },
};
