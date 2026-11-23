// ===========================================================
// bg_notes.js - 本機自訂暱稱與備註儲存 (100% 本機 IndexedDB)
// 用途：完全在瀏覽器本機保存使用者設定的自訂暱稱與備註，不上傳至任何伺服器。
// ===========================================================

const ViewerNotesModel = {
  CHANNEL_ID: /^UC[A-Za-z0-9_-]{22}$/,
  MAX_NICK_LEN: 50,
  MAX_NOTE_LEN: 300,
  MAX_NOTES: 50,

  normalizeHandle: function (raw) {
    const s = String(raw || "").trim().toLowerCase();
    return s.length > 1 && s[0] === "@" ? s : null;
  },

  normalizeChannelId: function (raw) {
    const s = String(raw || "").trim();
    return this.CHANNEL_ID.test(s) ? s : null;
  },

  normalizeIdentity: function (identity) {
    if (!identity || typeof identity !== "object") return { channelId: null, handle: null };
    return {
      channelId: this.normalizeChannelId(identity.channelId),
      handle: this.normalizeHandle(identity.handle),
    };
  },

  cleanNick: function (raw) {
    return typeof raw === "string" ? raw.trim().slice(0, this.MAX_NICK_LEN) : "";
  },

  cleanNote: function (raw) {
    return typeof raw === "string" ? raw.trim().slice(0, this.MAX_NOTE_LEN) : "";
  },

  cleanNotes: function (list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const text = this.cleanNote(item);
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
        if (out.length >= this.MAX_NOTES) break;
      }
    }
    return out;
  },

  createIndex: function () {
    const byKey = new Map();
    const handleToKey = new Map();

    const indexRecord = (rec) => {
      byKey.set(rec.key, rec);
      if (rec.handle) handleToKey.set(rec.handle, rec.key);
    };

    const unindexRecord = (rec) => {
      if (!rec) return;
      byKey.delete(rec.key);
      if (rec.handle && handleToKey.get(rec.handle) === rec.key) {
        handleToKey.delete(rec.handle);
      }
    };

    return {
      load: function (records) {
        byKey.clear();
        handleToKey.clear();
        for (const r of Array.isArray(records) ? records : []) {
          if (!r || typeof r !== "object") continue;
          const cid = ViewerNotesModel.normalizeChannelId(r.channelId || r.key);
          const handle = ViewerNotesModel.normalizeHandle(r.handle || (!cid ? r.key : null));
          const key = cid || handle;
          if (!key) continue;
          const customNickname = ViewerNotesModel.cleanNick(r.customNickname);
          const notes = ViewerNotesModel.cleanNotes(r.notes);
          if (!customNickname && notes.length === 0) continue;
          indexRecord({
            key,
            channelId: cid,
            handle,
            customNickname,
            notes,
            updatedAt: Number(r.updatedAt) || Date.now(),
          });
        }
        return this;
      },

      find: function (identity) {
        const { channelId, handle } = ViewerNotesModel.normalizeIdentity(identity);
        if (channelId && byKey.has(channelId)) return byKey.get(channelId);
        if (handle) {
          const mapped = handleToKey.get(handle);
          if (mapped && byKey.has(mapped)) return byKey.get(mapped);
          if (byKey.has(handle)) return byKey.get(handle);
        }
        return null;
      },

      patch: function (identity, patch, now = Date.now()) {
        const { channelId, handle } = ViewerNotesModel.normalizeIdentity(identity);
        const primaryKey = channelId || handle;
        if (!primaryKey) return { record: null, saved: null, removedKeys: [] };

        const removedKeys = [];
        let existing = this.find({ channelId, handle });
        // If a record previously lived under @handle and we now know its channelId, migrate it
        if (channelId && handle && byKey.has(handle) && byKey.get(handle) !== existing) {
          const legacy = byKey.get(handle);
          if (!existing) {
            existing = legacy;
          } else {
            // Merge legacy notes & nickname into channelId record
            const mergedNotes = ViewerNotesModel.cleanNotes([...existing.notes, ...legacy.notes]);
            existing = {
              ...existing,
              customNickname: existing.customNickname || legacy.customNickname,
              notes: mergedNotes,
            };
            unindexRecord(legacy);
            removedKeys.push(legacy.key);
          }
        }
        if (existing && existing.key !== primaryKey) {
          unindexRecord(existing);
          removedKeys.push(existing.key);
        }

        let customNickname = existing ? existing.customNickname : "";
        let notes = existing ? existing.notes.slice() : [];
        const mergedHandle = handle || (existing ? existing.handle : null);
        const mergedCid = channelId || (existing ? existing.channelId : null);

        if (patch && typeof patch === "object") {
          if ("customNickname" in patch) {
            customNickname = ViewerNotesModel.cleanNick(patch.customNickname);
          }
          if (Array.isArray(patch.notes)) {
            notes = ViewerNotesModel.cleanNotes(patch.notes);
          }
          if (typeof patch.addNote === "string") {
            const note = ViewerNotesModel.cleanNote(patch.addNote);
            if (note && !notes.includes(note) && notes.length < ViewerNotesModel.MAX_NOTES) {
              notes.push(note);
            }
          }
          if (typeof patch.removeNote === "string") {
            const target = ViewerNotesModel.cleanNote(patch.removeNote);
            notes = notes.filter((n) => n !== target);
          }
        }

        if (!customNickname && notes.length === 0) {
          if (existing) {
            unindexRecord(existing);
            if (!removedKeys.includes(existing.key)) removedKeys.push(existing.key);
          }
          return { record: null, saved: null, removedKeys };
        }

        const next = {
          key: primaryKey,
          channelId: mergedCid,
          handle: mergedHandle,
          customNickname,
          notes,
          updatedAt: now,
        };
        indexRecord(next);
        return { record: next, saved: next, removedKeys };
      },

      count: function () {
        return byKey.size;
      },

      list: function () {
        return Array.from(byKey.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      },

      removeKey: function (key) {
        const rec = byKey.get(key);
        if (!rec) return false;
        unindexRecord(rec);
        return true;
      },

      clear: function () {
        byKey.clear();
        handleToKey.clear();
      },
    };
  },
};

const BgNotes = {
  DB_NAME: "sm_viewer_local_notes_db",
  STORE_NAME: "notes",
  REV_KEY: "sm_viewer_notes_rev",

  index: ViewerNotesModel.createIndex(),
  store: null,
  readyPromise: null,

  ready: function () {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        try {
          if (typeof idbKeyval !== "undefined") {
            this.store = idbKeyval.createStore(this.DB_NAME, this.STORE_NAME);
            const entries = await idbKeyval.entries(this.store);
            this.index.load(entries.map(([, val]) => val));
          }
        } catch (e) {
          if (typeof Logger !== "undefined") Logger.red("[BgNotes] 載入失敗:", e);
        }
      })();
    }
    return this.readyPromise;
  },

  bumpRev: function () {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [this.REV_KEY]: Date.now() });
      }
    } catch {
      // ignore
    }
  },

  lookup: async function (ids) {
    await this.ready();
    const list = Array.isArray(ids) ? ids.slice(0, 200) : [];
    return {
      records: list.map((id) => this.index.find(id)),
    };
  },

  getAll: async function () {
    await this.ready();
    return this.index.list();
  },

  save: async function (identity, patch) {
    await this.ready();
    const res = this.index.patch(identity, patch);
    try {
      if (this.store) {
        if (res.removedKeys.length) await idbKeyval.delMany(res.removedKeys, this.store);
        if (res.saved) await idbKeyval.set(res.saved.key, res.saved, this.store);
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.red("[BgNotes] 寫入失敗:", e);
    }
    this.bumpRev();
    return { record: res.record };
  },

  remove: async function (key) {
    await this.ready();
    if (!key) return { success: false };
    this.index.removeKey(key);
    try {
      if (this.store) await idbKeyval.del(key, this.store);
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.red("[BgNotes] 刪除失敗:", e);
    }
    this.bumpRev();
    return { success: true };
  },

  importRecords: async function (records) {
    await this.ready();
    if (!Array.isArray(records)) return { count: 0 };
    let count = 0;
    const toWrite = [];
    const toRemove = [];
    for (const r of records) {
      if (!r || typeof r !== "object") continue;
      const cid = ViewerNotesModel.normalizeChannelId(r.channelId || r.key);
      const handle = ViewerNotesModel.normalizeHandle(r.handle || (!cid ? r.key : null));
      if (!cid && !handle) continue;
      const patch = {};
      if (typeof r.customNickname === "string") patch.customNickname = r.customNickname;
      if (Array.isArray(r.notes)) patch.notes = r.notes;
      const res = this.index.patch({ channelId: cid, handle }, patch, Number(r.updatedAt) || Date.now());
      if (res.removedKeys.length) toRemove.push(...res.removedKeys);
      if (res.saved) {
        toWrite.push([res.saved.key, res.saved]);
        count++;
      }
    }
    try {
      if (this.store) {
        if (toRemove.length) await idbKeyval.delMany(toRemove, this.store);
        if (toWrite.length) {
          if (idbKeyval.setMany) await idbKeyval.setMany(toWrite, this.store);
          else await Promise.all(toWrite.map(([k, v]) => idbKeyval.set(k, v, this.store)));
        }
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.red("[BgNotes] 匯入失敗:", e);
    }
    this.bumpRev();
    return { count };
  },

  getCount: async function () {
    await this.ready();
    return this.index.count();
  },

  clear: async function () {
    await this.ready();
    this.index.clear();
    try {
      if (this.store) await idbKeyval.clear(this.store);
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.red("[BgNotes] 清除失敗:", e);
    }
    this.bumpRev();
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ViewerNotesModel, BgNotes };
}
