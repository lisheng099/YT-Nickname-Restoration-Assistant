// ===========================================================
// bg_notes.js - 本機自訂暱稱與備註儲存 (100% 本機 IndexedDB)
// 用途：完全在瀏覽器本機保存使用者設定的自訂暱稱與備註，不上傳至任何伺服器。
// 說明：主鍵規則、索引、字串清理與寫入流程來自共用的 notes_core.js (與主播版相同)；
//       這裡只留觀眾版的欄位 (暱稱、備註) 與合併規則。
// ===========================================================

// background.js 以 importScripts 先載入 ../shared/notes_core.js；Node 測試則在這裡 require
const NotesCoreRef =
  typeof NotesCore !== "undefined" ? NotesCore : typeof require !== "undefined" ? require("../shared/notes_core.js") : null;

const ViewerNotesModel = {
  CHANNEL_ID: NotesCoreRef.CHANNEL_ID,
  // 與主播版、worker 相同的上限 (notes_core.js)；1.3.3 以前暱稱可到 50 字、備註 300 字，舊資料超過的部分會被截掉
  MAX_NICK_LEN: NotesCoreRef.LIMITS.NICKNAME,
  MAX_NOTE_LEN: NotesCoreRef.LIMITS.NOTE,
  MAX_NOTES: NotesCoreRef.LIMITS.NOTES,

  // Lowercase, 2-61 characters, no spaces or , / ? # & (fixtures/handle_cases.json). Unlike typed input, a value
  // without @ is not a handle here: on the page it is a display name, so it must never become a key.
  normalizeHandle: function (raw) {
    const s = String(raw || "").trim().toLowerCase();
    return NotesCoreRef.isHandleShape(s) ? s : null;
  },

  normalizeChannelId: function (raw) {
    return NotesCoreRef.channelIdOf(String(raw || "").trim());
  },

  normalizeIdentity: function (identity) {
    if (!identity || typeof identity !== "object") return { channelId: null, handle: null };
    return {
      channelId: this.normalizeChannelId(identity.channelId),
      handle: this.normalizeHandle(identity.handle),
    };
  },

  cleanNick: function (raw) {
    return NotesCoreRef.cleanText(raw, this.MAX_NICK_LEN);
  },

  cleanNote: function (raw) {
    return NotesCoreRef.cleanText(raw, this.MAX_NOTE_LEN);
  },

  cleanNotes: function (list) {
    return NotesCoreRef.uniqueTexts(list, this.MAX_NOTE_LEN, this.MAX_NOTES);
  },

  /**
   * The patch that merges one backup record into what is stored, or null when it adds nothing.
   * Importing never deletes: notes are unioned, and the nickname from the backup wins only when the
   * local record has none or is not newer than the backup.
   */
  mergeImportPatch: function (existing, record) {
    if (!record || typeof record !== "object") return null;
    const nick = this.cleanNick(record.customNickname);
    const notes = this.cleanNotes(record.notes);
    if (!nick && notes.length === 0) return null;
    const incomingAt = Number(record.updatedAt) || 0;
    const localAt = existing ? Number(existing.updatedAt) || 0 : 0;
    const patch = { notes: this.cleanNotes([...(existing ? existing.notes : []), ...notes]) };
    if (nick && (!existing || !existing.customNickname || incomingAt >= localAt)) {
      patch.customNickname = nick;
    }
    return { patch, updatedAt: Math.max(incomingAt, localAt) || Date.now() };
  },

  createIndex: function () {
    const keys = NotesCoreRef.createKeyIndex();
    const byKey = keys.byKey;
    const indexRecord = (rec) => keys.put(rec);
    const unindexRecord = (rec) => keys.drop(rec);

    return {
      load: function (records) {
        keys.clear();
        for (const r of Array.isArray(records) ? records : []) {
          if (!r || typeof r !== "object") continue;
          const cid = ViewerNotesModel.normalizeChannelId(r.channelId || r.key);
          const handle = ViewerNotesModel.normalizeHandle(r.handle || (!cid ? r.key : null));
          const key = NotesCoreRef.recordKey(cid, handle);
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
        return keys.find(channelId, handle);
      },

      patch: function (identity, patch, now = Date.now()) {
        const { channelId, handle } = ViewerNotesModel.normalizeIdentity(identity);
        const primaryKey = NotesCoreRef.recordKey(channelId, handle);
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
        return keys.size;
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
        keys.clear();
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
    NotesCoreRef.bumpRev(this.REV_KEY);
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
      if (this.store) await NotesCoreRef.writeChanges(idbKeyval, this.store, res.saved ? [res.saved] : [], res.removedKeys);
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
    const changes = NotesCoreRef.createChangeSet();
    for (const r of records) {
      if (!r || typeof r !== "object") continue;
      const cid = ViewerNotesModel.normalizeChannelId(r.channelId || r.key);
      const handle = ViewerNotesModel.normalizeHandle(r.handle || (!cid ? r.key : null));
      if (!cid && !handle) continue;
      const merged = ViewerNotesModel.mergeImportPatch(this.index.find({ channelId: cid, handle }), r);
      if (!merged) continue;
      const res = this.index.patch({ channelId: cid, handle }, merged.patch, merged.updatedAt);
      changes.add(res);
      if (res.saved) count++;
    }
    try {
      if (this.store) {
        await NotesCoreRef.writeChanges(idbKeyval, this.store, [...changes.saved.values()], [...changes.removed]);
      }
    } catch (e) {
      if (typeof Logger !== "undefined") Logger.red("[BgNotes] 匯入失敗:", e);
      // keep the in-memory index in step with what is actually stored
      try {
        const entries = await idbKeyval.entries(this.store);
        this.index.load(entries.map(([, val]) => val));
      } catch {
        // ignore: the next service worker start reloads from storage
      }
      this.bumpRev();
      return { count: 0, error: true };
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
