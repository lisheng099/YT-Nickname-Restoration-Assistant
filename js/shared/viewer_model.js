// ===========================================================
// viewer_model.js - 觀眾筆記資料模型 (純邏輯)
// 用途：標籤、備註、評分與自訂暱稱的正規化、索引、合併與匯入匯出。
// 說明：不依賴瀏覽器 API，背景服務、管理頁與單元測試共用同一份。
// ===========================================================

(function (root) {
  const FORMAT = "yt-viewer-notes-v1";
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  const COLOR = /^#[0-9a-fA-F]{6}$/;

  const DEFAULT_REACTION_DEFS = [
    { id: "r_like", icon: "👍", label: "讚" },
    { id: "r_laugh", icon: "😂", label: "笑" },
    { id: "r_sad", icon: "😢", label: "哭" },
    { id: "r_angry", icon: "😡", label: "怒" },
    { id: "r_boo", icon: "👎", label: "噓" },
  ];
  const DEFAULT_REACTIONS = DEFAULT_REACTION_DEFS.map((d) => d.icon);

  const LIMITS = {
    NICKNAME: 50,
    NAME: 100,
    NOTE: 500,
    NOTES: 50,
    TAG_LABEL: 30,
    TAGS: 100,
    TAGS_PER_VIEWER: 30,
    SCORE: 1000000,
    REACTION_COUNT: 1000000,
    REACTIONS_PER_VIEWER: 30,
    REACTION_DEFS: 30,
    REACTION_KEY: 40,
    REACTION_ICON: 8,
    REACTION_LABEL: 20,
    VIEWERS: 50000,
    EXT_TAGS: 20,
  };

  const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

  function normalizeChannelId(value) {
    return typeof value === "string" && CHANNEL_ID.test(value) ? value : null;
  }

  // handle 一律以小寫、含 @ 儲存；YouTube 的 handle 不分大小寫
  function normalizeHandle(value) {
    if (typeof value !== "string") return null;
    let h = value.trim();
    if (!h) return null;
    if (!h.startsWith("@")) h = "@" + h;
    if (h.length < 2 || h.length > 80 || /\s/.test(h)) return null;
    return h.toLowerCase();
  }

  function clampScore(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 0;
    return Math.max(-LIMITS.SCORE, Math.min(LIMITS.SCORE, n));
  }

  function normalizeReactionKey(value) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, LIMITS.REACTION_KEY);
  }

  function normalizeReactionDef(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = text(raw.id, 40);
    const icon = text(raw.icon, LIMITS.REACTION_ICON);
    const label = text(raw.label, LIMITS.REACTION_LABEL) || icon;
    if (!id || !icon) return null;
    return { id, icon, label };
  }

  function normalizeReactionDefs(list) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const raw of list) {
      const def = normalizeReactionDef(raw);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      out.push(def);
      if (out.length >= LIMITS.REACTION_DEFS) break;
    }
    return out;
  }

  function defaultReactionDefs() {
    return DEFAULT_REACTION_DEFS.map((d) => ({ ...d }));
  }

  function normalizeReactions(raw) {
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    let count = 0;
    for (const [k, v] of Object.entries(raw)) {
      const key = normalizeReactionKey(k);
      const n = Math.round(Number(v));
      if (!key || !Number.isFinite(n) || n <= 0) continue;
      out[key] = Math.min(LIMITS.REACTION_COUNT, (out[key] || 0) + n);
      count++;
      if (count >= LIMITS.REACTIONS_PER_VIEWER) break;
    }
    return out;
  }

  function totalReactions(rec) {
    if (!rec || !rec.reactions) return 0;
    let sum = 0;
    for (const n of Object.values(rec.reactions)) sum += Number(n) || 0;
    return sum;
  }

  function mergeReactions(a, b) {
    const merged = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      merged[k] = (merged[k] || 0) + (Number(v) || 0);
    }
    return normalizeReactions(merged);
  }

  function uniqueStrings(list, maxLen, maxCount) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const item of list) {
      const s = text(item, maxLen);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= maxCount) break;
    }
    return out;
  }

  function normalizeTagDef(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = text(raw.id, 40);
    const label = text(raw.label, LIMITS.TAG_LABEL);
    if (!id || !label) return null;
    return { id, label, color: COLOR.test(raw.color || "") ? raw.color.toLowerCase() : "" };
  }

  function normalizeTagDefs(list) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const raw of list) {
      const def = normalizeTagDef(raw);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      out.push(def);
      if (out.length >= LIMITS.TAGS) break;
    }
    return out;
  }

  // 外部唯讀資料 (由附加模組寫入，本體只負責顯示)
  function normalizeExt(raw) {
    if (!raw || typeof raw !== "object") return null;
    const tags = [];
    if (Array.isArray(raw.tags)) {
      for (const t of raw.tags) {
        const label = text(t && t.label, LIMITS.TAG_LABEL);
        if (!label) continue;
        tags.push({ label, color: COLOR.test((t && t.color) || "") ? t.color.toLowerCase() : "" });
        if (tags.length >= LIMITS.EXT_TAGS) break;
      }
    }
    const aiTags = uniqueStrings(raw.aiTags, LIMITS.TAG_LABEL, LIMITS.EXT_TAGS);
    const name = text(raw.name, LIMITS.NAME);
    if (tags.length === 0 && aiTags.length === 0 && !name) return null;
    return { tags, aiTags, name };
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const channelId = normalizeChannelId(raw.channelId);
    const handle = normalizeHandle(raw.handle);
    if (!channelId && !handle) return null;
    const customNickname = text(raw.customNickname, LIMITS.NICKNAME);
    const updatedAt = Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : 0;
    const nicknameAt =
      Number.isFinite(Number(raw.nicknameAt)) && Number(raw.nicknameAt) > 0 ? Number(raw.nicknameAt) : updatedAt;
    return {
      key: channelId || handle,
      channelId,
      handle,
      name: text(raw.name, LIMITS.NAME),
      customNickname,
      nicknameAt,
      tagIds: uniqueStrings(raw.tagIds, 40, LIMITS.TAGS_PER_VIEWER),
      notes: uniqueStrings(raw.notes, LIMITS.NOTE, LIMITS.NOTES),
      score: clampScore(raw.score),
      reactions: normalizeReactions(raw.reactions),
      updatedAt,
      ext: normalizeExt(raw.ext),
    };
  }

  function isEmpty(rec) {
    return (
      !rec.customNickname &&
      rec.tagIds.length === 0 &&
      rec.notes.length === 0 &&
      rec.score === 0 &&
      totalReactions(rec) === 0 &&
      !rec.ext
    );
  }

  // 兩筆指向同一人的紀錄合併：標籤與備註取聯集、評分與表情次數相加、暱稱取較新者
  function mergeRecords(base, other) {
    const newer = (other.nicknameAt || 0) > (base.nicknameAt || 0);
    const nickFrom = (newer && other.customNickname) || !base.customNickname ? other : base;
    return normalizeRecord({
      channelId: base.channelId || other.channelId,
      handle: base.handle || other.handle,
      name: base.name || other.name,
      customNickname: nickFrom.customNickname,
      nicknameAt: nickFrom.nicknameAt,
      tagIds: [...base.tagIds, ...other.tagIds],
      notes: [...base.notes, ...other.notes],
      score: base.score + other.score,
      reactions: mergeReactions(base.reactions, other.reactions),
      updatedAt: Math.max(base.updatedAt, other.updatedAt),
      ext: base.ext || other.ext,
    });
  }

  class ViewerIndex {
    constructor() {
      this.byKey = new Map();
      this.byHandle = new Map(); // handle -> key
      this.tags = [];
      this.reactionDefs = defaultReactionDefs();
    }

    load(records, tags, reactionDefs) {
      this.byKey.clear();
      this.byHandle.clear();
      this.tags = normalizeTagDefs(tags);
      this.reactionDefs = Array.isArray(reactionDefs) ? normalizeReactionDefs(reactionDefs) : defaultReactionDefs();
      for (const raw of records || []) {
        const rec = normalizeRecord(raw);
        if (rec) this._put(rec);
      }
      return this;
    }

    get size() {
      return this.byKey.size;
    }

    list() {
      return [...this.byKey.values()];
    }

    _put(rec) {
      this.byKey.set(rec.key, rec);
      if (rec.handle) this.byHandle.set(rec.handle, rec.key);
    }

    _drop(rec) {
      this.byKey.delete(rec.key);
      if (rec.handle && this.byHandle.get(rec.handle) === rec.key) this.byHandle.delete(rec.handle);
    }

    // 以 channel id 為優先；沒有時退回 handle
    find(identity) {
      const channelId = normalizeChannelId(identity && identity.channelId);
      const handle = normalizeHandle(identity && identity.handle);
      if (channelId && this.byKey.has(channelId)) return this.byKey.get(channelId);
      if (handle) {
        const key = this.byHandle.get(handle);
        const rec = key ? this.byKey.get(key) : this.byKey.get(handle);
        // 以 handle 找到的紀錄若屬於另一個 channel id，就不是同一人
        if (rec && !(channelId && rec.channelId && rec.channelId !== channelId)) return rec;
      }
      return null;
    }

    /**
     * 套用修改並回傳 { record, removedKeys, saved }。
     * patch: { customNickname, tagIds, addTagId, removeTagId, notes, addNote, removeNote,
     *          score, scoreDelta, name, ext }
     * 內容清空的紀錄會被移除 (record 為 null)。
     */
    patch(identity, patch, now = Date.now()) {
      const channelId = normalizeChannelId(identity && identity.channelId);
      const handle = normalizeHandle(identity && identity.handle);
      if (!channelId && !handle) return { record: null, removedKeys: [], saved: null };
      const removedKeys = [];

      let rec = this.find({ channelId, handle });
      if (!rec) {
        rec = normalizeRecord({ channelId, handle });
      } else {
        rec = { ...rec, tagIds: [...rec.tagIds], notes: [...rec.notes], reactions: { ...(rec.reactions || {}) } };
        const oldKey = rec.key;
        this._drop(rec);
        // 之前只知道 handle，現在知道 channel id：改以 channel id 為主鍵
        if (channelId && !rec.channelId) {
          rec.channelId = channelId;
          rec.key = channelId;
          removedKeys.push(oldKey);
          const other = this.byKey.get(channelId);
          if (other) {
            this._drop(other);
            rec = mergeRecords(other, rec);
          }
        }
        // 同一人另有一筆只以 handle 記錄的資料：併入這一筆
        const orphan = channelId && handle ? this.byKey.get(handle) : null;
        if (orphan && !orphan.channelId && orphan.key !== rec.key) {
          this._drop(orphan);
          removedKeys.push(orphan.key);
          rec = mergeRecords(rec, orphan);
        }
        if (handle) rec.handle = handle; // handle 可能更名，以最近看到的為準
      }

      const p = patch || {};
      if (typeof p.name === "string") rec.name = text(p.name, LIMITS.NAME);
      if (p.customNickname !== undefined) {
        const next = text(p.customNickname, LIMITS.NICKNAME);
        if (next !== rec.customNickname) {
          rec.customNickname = next;
          rec.nicknameAt = Number(p.nicknameAt) > 0 ? Number(p.nicknameAt) : now;
        }
      }
      if (Array.isArray(p.tagIds)) rec.tagIds = p.tagIds;
      if (p.addTagId) rec.tagIds = [...rec.tagIds, p.addTagId];
      if (p.removeTagId) rec.tagIds = rec.tagIds.filter((id) => id !== p.removeTagId);
      if (Array.isArray(p.notes)) rec.notes = p.notes;
      if (p.addNote) rec.notes = [...rec.notes, p.addNote];
      if (p.removeNote) rec.notes = rec.notes.filter((n) => n !== p.removeNote);
      if (p.score !== undefined) rec.score = clampScore(p.score);
      if (p.scoreDelta) rec.score = clampScore(rec.score + clampScore(p.scoreDelta));
      if (p.reactions !== undefined) rec.reactions = normalizeReactions(p.reactions);
      if (p.clearReactions) rec.reactions = {};
      if (p.reactionDelta && typeof p.reactionDelta === "object") {
        const key = normalizeReactionKey(p.reactionDelta.key || p.reactionDelta.emoji);
        const delta = Math.round(Number(p.reactionDelta.delta));
        if (key && Number.isFinite(delta) && delta !== 0) {
          const next = { ...(rec.reactions || {}) };
          const val = Math.max(0, Math.min(LIMITS.REACTION_COUNT, (next[key] || 0) + delta));
          if (val > 0) next[key] = val;
          else delete next[key];
          rec.reactions = normalizeReactions(next);
        }
      }
      if (Array.isArray(p.reactionDeltas)) {
        const next = { ...(rec.reactions || {}) };
        for (const item of p.reactionDeltas) {
          if (!item || typeof item !== "object") continue;
          const key = normalizeReactionKey(item.key || item.emoji);
          const delta = Math.round(Number(item.delta));
          if (!key || !Number.isFinite(delta) || delta === 0) continue;
          const val = Math.max(0, Math.min(LIMITS.REACTION_COUNT, (next[key] || 0) + delta));
          if (val > 0) next[key] = val;
          else delete next[key];
        }
        rec.reactions = normalizeReactions(next);
      }
      if (p.ext !== undefined) rec.ext = p.ext;
      // 只保留仍存在的標籤
      const known = new Set(this.tags.map((t) => t.id));
      rec.tagIds = (rec.tagIds || []).filter((id) => known.has(id));
      if (!p.silent) rec.updatedAt = now;

      rec = normalizeRecord(rec);
      if (!rec || isEmpty(rec)) {
        if (rec && !removedKeys.includes(rec.key)) removedKeys.push(rec.key);
        return { record: null, removedKeys, saved: null };
      }
      this._put(rec);
      return { record: rec, removedKeys: removedKeys.filter((k) => k !== rec.key), saved: rec };
    }

    remove(key) {
      const rec = this.byKey.get(key);
      if (rec) this._drop(rec);
      return !!rec;
    }

    /** 更新標籤定義；回傳因標籤被刪除而變動的紀錄與被清空的主鍵。 */
    setTags(defs, now = Date.now()) {
      this.tags = normalizeTagDefs(defs);
      const known = new Set(this.tags.map((t) => t.id));
      const changed = [];
      const removedKeys = [];
      for (const rec of this.list()) {
        const kept = rec.tagIds.filter((id) => known.has(id));
        if (kept.length === rec.tagIds.length) continue;
        const next = { ...rec, tagIds: kept, updatedAt: now };
        if (isEmpty(next)) {
          this._drop(rec);
          removedKeys.push(rec.key);
        } else {
          this._put(next);
          changed.push(next);
        }
      }
      return { changed, removedKeys };
    }

    /** 更新反應項目定義 (視窗顯示 icon 對應後台顯示詞語 label)。 */
    setReactionDefs(defs) {
      this.reactionDefs = normalizeReactionDefs(defs);
      return this.reactionDefs;
    }

    exportData(now = Date.now()) {
      return {
        format: FORMAT,
        exported_at: new Date(now).toISOString(),
        tags: this.tags.map((t) => ({ ...t })),
        reactionDefs: this.reactionDefs.map((d) => ({ ...d })),
        viewers: this.list().map((r) => ({
          channelId: r.channelId,
          handle: r.handle,
          name: r.name,
          customNickname: r.customNickname,
          nicknameAt: r.nicknameAt,
          tagIds: [...r.tagIds],
          notes: [...r.notes],
          score: r.score,
          reactions: { ...(r.reactions || {}) },
          updatedAt: r.updatedAt,
        })),
      };
    }

    /**
     * 匯入備份。mode "replace" 以檔案內容取代現有資料；"merge" 與現有資料合併
     * (同 id 的標籤以檔案為準，同一位觀眾的標籤與備註取聯集、評分與表情次數取檔案的值)。
     * 回傳 { imported, skipped }；格式不符時丟出 Error("format")。
     */
    importData(data, mode = "merge") {
      if (!data || typeof data !== "object" || data.format !== FORMAT || !Array.isArray(data.viewers)) {
        throw new Error("format");
      }
      const incomingTags = normalizeTagDefs(data.tags);
      const hasReactionDefs = Array.isArray(data.reactionDefs);
      const incomingReactionDefs = hasReactionDefs ? normalizeReactionDefs(data.reactionDefs) : null;
      if (mode === "replace") {
        this.byKey.clear();
        this.byHandle.clear();
        this.tags = incomingTags;
        this.reactionDefs = incomingReactionDefs || defaultReactionDefs();
      } else {
        const merged = new Map(this.tags.map((t) => [t.id, t]));
        incomingTags.forEach((t) => merged.set(t.id, t));
        this.tags = [...merged.values()].slice(0, LIMITS.TAGS);
        if (incomingReactionDefs) {
          const mergedR = new Map(this.reactionDefs.map((d) => [d.id, d]));
          incomingReactionDefs.forEach((d) => mergedR.set(d.id, d));
          this.reactionDefs = [...mergedR.values()].slice(0, LIMITS.REACTION_DEFS);
        }
      }
      const known = new Set(this.tags.map((t) => t.id));
      let imported = 0;
      let skipped = 0;
      for (const raw of data.viewers.slice(0, LIMITS.VIEWERS)) {
        const rec = normalizeRecord(raw);
        if (!rec) {
          skipped++;
          continue;
        }
        rec.ext = null;
        rec.tagIds = rec.tagIds.filter((id) => known.has(id));
        if (isEmpty(rec)) {
          skipped++;
          continue;
        }
        const existing = this.find(rec);
        if (existing) {
          this._drop(existing);
          const merged = mergeRecords(
            { ...rec, score: 0, reactions: {}, ext: existing.ext },
            { ...existing, score: 0, reactions: {} }
          );
          merged.score = rec.score;
          merged.reactions = { ...rec.reactions };
          merged.ext = existing.ext;
          this._put(merged);
        } else {
          this._put(rec);
        }
        imported++;
      }
      return { imported, skipped };
    }
  }

  /** 產生不與現有標籤重複的 id */
  function newTagId(existing) {
    const used = new Set((existing || []).map((t) => t.id));
    let id;
    do {
      id = "t" + Math.random().toString(36).slice(2, 10);
    } while (used.has(id));
    return id;
  }

  /** 產生不與現有反應項目重複的 id */
  function newReactionId(existing) {
    const used = new Set((existing || []).map((d) => d.id));
    let id;
    do {
      id = "r" + Math.random().toString(36).slice(2, 10);
    } while (used.has(id));
    return id;
  }

  const api = {
    FORMAT,
    DEFAULT_REACTION_DEFS,
    DEFAULT_REACTIONS,
    LIMITS,
    ViewerIndex,
    normalizeRecord,
    normalizeChannelId,
    normalizeHandle,
    normalizeTagDefs,
    normalizeReactionDefs,
    defaultReactionDefs,
    normalizeReactions,
    totalReactions,
    normalizeExt,
    mergeRecords,
    isEmpty,
    newTagId,
    newReactionId,
  };
  root.ViewerModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
