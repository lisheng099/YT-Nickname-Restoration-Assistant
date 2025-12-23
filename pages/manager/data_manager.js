// ===========================================================
// data_manager.js - 資料存取服務層 (IndexedDB 版)
// 用途：封裝 IndexedDB 操作 (透過 idb-keyval)
// ===========================================================

const DataManager = {
  TTL: window.AppConfig.TTL,
  LOCK_NAME: "yt_realname_storage_lock",

  // === 讀取與列表 ===
  async getAllList() {
    try {
      // 讀取所有資料 [key, value]
      const entries = await idbKeyval.entries();
      const list = [];

      for (const [handle, data] of entries) {
        if (!data) continue;
        const name = data.name || (typeof data === "string" ? data : null);
        if (!name) continue;

        list.push({
          id: handle,
          name: name,
          subs: data.subs || 0,
          ts: data.ts || 0,
        });
      }
      return list;
    } catch (err) {
      console.error("IDB Read Error:", err);
      return [];
    }
  },

  async getRawData() {
    try {
      const entries = await idbKeyval.entries();
      const raw = {};
      for (const [key, val] of entries) {
        raw[key] = val;
      }
      return raw;
    } catch (err) {
      return {};
    }
  },

  // === 寫入操作 ===
  async deleteItems(ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0) return;

    if (idbKeyval.delMany) {
      await idbKeyval.delMany(idArray);
    } else {
      await Promise.all(idArray.map((id) => idbKeyval.del(id)));
    }
  },

  async expireItems(ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0) return;

    // 平行處理更新
    const pastTime = Date.now() - this.TTL - 10000;
    const tasks = idArray.map((id) => {
      return idbKeyval.update(id, (val) => {
        if (!val) return undefined;
        if (typeof val === "string")
          return { name: val, subs: 0, ts: pastTime };
        return { ...val, ts: pastTime };
      });
    });
    await Promise.all(tasks);
  },

  async clearAll() {
    return idbKeyval.clear();
  },

  // === 匯入匯出 ===
  async generateBackup() {
    const raw = await this.getRawData();
    const checksum = await this._computeChecksum(raw);
    return {
      meta: {
        version: chrome.runtime.getManifest().version,
        generatedAt: Date.now(),
        checksum: checksum,
      },
      data: raw,
    };
  },

  async importData(dataToImport, isTrusted) {
    if (!dataToImport) return 0;
    const now = Date.now();
    const forcedExpiredTs = now - this.TTL - 60000;
    const entriesToWrite = [];

    for (const [key, val] of Object.entries(dataToImport)) {
      const entry = val || {};
      const name = entry.name || (typeof entry === "string" ? entry : null);
      if (!name) continue;

      let finalTs;
      if (isTrusted) {
        const originTs = entry.ts || now;
        const hasSubs = entry.subs && entry.subs > 0;
        if (originTs > now || hasSubs) {
          finalTs = forcedExpiredTs;
        } else {
          finalTs = originTs;
        }
      } else {
        finalTs = forcedExpiredTs;
      }

      entriesToWrite.push([
        key,
        { name: name, subs: entry.subs || 0, ts: finalTs },
      ]);
    }

    if (entriesToWrite.length === 0) return 0;

    if (idbKeyval.setMany) {
      await idbKeyval.setMany(entriesToWrite);
    } else {
      await Promise.all(entriesToWrite.map(([k, v]) => idbKeyval.set(k, v)));
    }
    return entriesToWrite.length;
  },

  async verifyChecksum(json) {
    if (!json.meta || !json.data) return false;
    const calculatedHash = await this._computeChecksum(json.data);
    return calculatedHash === json.meta.checksum;
  },

  async _computeChecksum(data) {
    const orderedData = {};
    Object.keys(data)
      .sort()
      .forEach((key) => {
        orderedData[key] = data[key];
      });
    const msgUint8 = new TextEncoder().encode(JSON.stringify(orderedData));
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },
};
