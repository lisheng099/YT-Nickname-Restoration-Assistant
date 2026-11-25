// ===========================================================
// people.js - 觀眾資料頁的清單邏輯 (純函式，Node 測試可直接 require)
// 用途：把「頻道名稱快取」與「自訂暱稱與備註」合成一份以人為單位的清單，
//       以及搜尋、篩選、排序與新增時的身分解析。
// 說明：快取只是名稱來源；同一個人以頻道 ID 優先、@handle 備用對上筆記紀錄。
// ===========================================================

(function (root) {
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

  function isHandleShape(h) {
    if (root.NotesCore && typeof root.NotesCore.isHandleShape === "function") return root.NotesCore.isHandleShape(h);
    return typeof h === "string" && h.length >= 2 && h.length <= 61 && h[0] === "@" && !/[\s,/?#&]/.test(h);
  }

  /**
   * cacheList：DataManager.getAllList() 的結果 ({ id, name, subs, ts, cid?, isExpired, daysUntilDelete })
   * noteRecords：NOTES_LIST 的結果 ({ key, channelId, handle, customNickname, notes, updatedAt })
   * 回傳每人一列：{ rowKey, handle, channelId, name, subs, ts, isExpired, daysUntilDelete, inCache, note, recent }
   */
  function buildRows(cacheList, noteRecords) {
    const notes = Array.isArray(noteRecords) ? noteRecords.filter((r) => r && r.key) : [];
    const byCid = new Map();
    const byHandle = new Map();
    for (const r of notes) {
      if (r.channelId) byCid.set(r.channelId, r);
      if (r.handle) byHandle.set(r.handle, r);
      if (!r.channelId && !r.handle) byHandle.set(r.key, r);
    }

    const used = new Set();
    const rows = [];
    for (const item of Array.isArray(cacheList) ? cacheList : []) {
      if (!item || !item.id) continue;
      const handle = String(item.id).toLowerCase();
      const cid = item.cid && CHANNEL_ID.test(item.cid) ? item.cid : null;
      const note = (cid && byCid.get(cid)) || byHandle.get(handle) || null;
      if (note) used.add(note.key);
      rows.push({
        rowKey: "c:" + handle,
        handle: handle.startsWith("@") ? handle : null,
        cacheId: item.id,
        channelId: cid || (note ? note.channelId : null) || null,
        name: item.name || "",
        subs: Number(item.subs) || 0,
        ts: Number(item.ts) || 0,
        isExpired: !!item.isExpired,
        daysUntilDelete: Number(item.daysUntilDelete) || 0,
        inCache: true,
        note,
        recent: Math.max(Number(item.ts) || 0, note ? Number(note.updatedAt) || 0 : 0),
      });
    }

    for (const r of notes) {
      if (used.has(r.key)) continue;
      rows.push({
        rowKey: "n:" + r.key,
        handle: r.handle || (isHandleShape(r.key) ? r.key : null),
        cacheId: null,
        channelId: r.channelId || null,
        name: "",
        subs: 0,
        ts: 0,
        isExpired: false,
        daysUntilDelete: 0,
        inCache: false,
        note: r,
        recent: Number(r.updatedAt) || 0,
      });
    }
    return rows;
  }

  function hasNote(row) {
    return !!(row.note && (row.note.customNickname || (Array.isArray(row.note.notes) && row.note.notes.length)));
  }

  /** filter："all" | "notes" (有暱稱或備註) | "cache" (只有名稱快取) */
  function filterRows(rows, term, filter) {
    const needle = String(term || "").trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "notes" && !hasNote(row)) return false;
      if (filter === "cache" && hasNote(row)) return false;
      if (!needle) return true;
      const hay = [
        row.handle,
        row.cacheId,
        row.channelId,
        row.name,
        row.note && row.note.customNickname,
        ...(row.note && Array.isArray(row.note.notes) ? row.note.notes : []),
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  /** key："recent" | "name" | "subs" | "handle" */
  function sortRows(rows, key, direction) {
    const dir = direction === "asc" ? 1 : -1;
    const label = (r) => (r.note && r.note.customNickname) || r.name || r.handle || r.channelId || "";
    const out = rows.slice();
    out.sort((a, b) => {
      let comp;
      if (key === "name") comp = label(a).localeCompare(label(b));
      else if (key === "handle") comp = String(a.handle || a.channelId || "").localeCompare(String(b.handle || b.channelId || ""));
      else if (key === "subs") comp = a.subs - b.subs;
      else comp = a.recent - b.recent;
      return comp * dir;
    });
    return out;
  }

  /**
   * 解析使用者在「新增」輸入的身分：@handle、頻道 ID (UC…)、或 YouTube 頻道網址。
   * 打字輸入沒有 @ 時自動補上 (與聊天室頁面資料不同：頁面上沒有 @ 的文字是顯示名稱，不當成 handle)。
   * 回傳 { channelId, handle } 或 null。
   */
  function parseIdentityInput(raw) {
    let s = String(raw || "").trim();
    if (!s) return null;
    const url = s.match(/youtube\.com\/(?:channel\/(UC[A-Za-z0-9_-]{22})|(@[^/?#\s]+))/i);
    if (url) {
      if (url[1]) return { channelId: url[1], handle: null };
      try {
        s = decodeURIComponent(url[2]);
      } catch {
        s = url[2];
      }
    }
    if (CHANNEL_ID.test(s)) return { channelId: s, handle: null };
    if (!s.startsWith("@")) s = "@" + s;
    s = s.toLowerCase();
    return isHandleShape(s) ? { channelId: null, handle: s } : null;
  }

  /** 新增時以輸入的身分在既有清單中找人 (頻道 ID 優先，再比 handle)。 */
  function findRow(rows, identity) {
    if (!identity) return null;
    if (identity.channelId) {
      const hit = rows.find((r) => r.channelId === identity.channelId);
      if (hit) return hit;
    }
    if (identity.handle) {
      return rows.find((r) => r.handle === identity.handle) || null;
    }
    return null;
  }

  const api = { buildRows, filterRows, sortRows, parseIdentityInput, findRow, hasNote };
  root.PeopleList = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
