// ===========================================================
// data_manager.js - 資料存取服務層
// 用途：封裝 IndexedDB 操作 (透過 idb-keyval)
// ===========================================================

const { TTL, SETTINGS_KEY, DEFAULT_TTL_DAYS, DEFAULT_DELETE_DAYS } =
  window.AppConfig;

const DataManager = {
  TTL: TTL, // 舊的靜態 TTL 保留給 expireItems 用
  LOCK_NAME: "yt_realname_storage_lock",

  // === 內部 helper: 取得動態設定 ===
  async _getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_KEY, (res) => {
        const settings = res[SETTINGS_KEY] || {};
        resolve({
          ttlDays: settings.ttlDays || DEFAULT_TTL_DAYS,
          deleteDays: settings.deleteDays || DEFAULT_DELETE_DAYS,
        });
      });
    });
  },

  // === 讀取與列表  ===
  async getAllList() {
    try {
      // 1. 同時等待：讀取資料庫 + 讀取設定
      const [entries, settings] = await Promise.all([
        idbKeyval.entries(),
        this._getSettings(),
      ]);

      const list = [];
      const now = Date.now();

      // 計算毫秒數
      const ttlMs = settings.ttlDays * 24 * 60 * 60 * 1000;
      const deleteMs = settings.deleteDays * 24 * 60 * 60 * 1000;

      for (const [handle, data] of entries) {
        if (!data) continue;
        const name = data.name || (typeof data === "string" ? data : null);
        if (!name) continue;

        const ts = data.ts || 0;

        // 算過期狀態與剩餘天數
        const isExpired = now - ts > ttlMs;
        let daysUntilDelete = 0;

        if (isExpired) {
          // 預計刪除時間 = 更新時間 + 刪除天數
          const deleteTime = ts + deleteMs;
          const remainingMs = deleteTime - now;
          // 無條件進位算天數
          daysUntilDelete = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
        }

        list.push({
          id: handle, // 對應原本的 handle
          handle: handle, // 為了相容性，多加這個 key
          name: name,
          subs: data.subs || 0,
          ts: ts,
          isExpired: isExpired, // [新欄位]
          daysUntilDelete: daysUntilDelete, // [新欄位]
        });
      }

      // 依照時間排序 (新的在前)
      list.sort((a, b) => b.ts - a.ts);

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

    chrome.runtime.sendMessage({ type: "CACHE_INVALIDATE", handles: idArray });
  },

  async expireItems(ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0) return;

    // 取得當前設定的 TTL 天數
    const settings = await this._getSettings();
    const ttlMs = settings.ttlDays * 24 * 60 * 60 * 1000;

    // 設定為：「現在時間」 減去 「TTL」 再多減 10 分鐘
    // 意義：這筆資料在 10 分鐘前「剛好過期」。
    // 結果：isExpired = true, 但距離 deleteDays (通常30天) 還很遠，不會被刪除。
    const forcedExpiredTs = Date.now() - ttlMs - 10 * 60 * 1000;

    const tasks = idArray.map((id) => {
      return idbKeyval.update(id, (val) => {
        if (!val) return undefined;

        // 處理舊資料格式 (如果存的是純字串)
        if (typeof val === "string")
          return { name: val, subs: 0, ts: forcedExpiredTs };

        // 更新時間戳記
        return { ...val, ts: forcedExpiredTs };
      });
    });
    await Promise.all(tasks);
    chrome.runtime.sendMessage({ type: "CACHE_INVALIDATE", handles: idArray });
  },

  async clearAll() {
    await idbKeyval.clear();
    chrome.runtime.sendMessage({ type: "CACHE_CLEAR_MEM" });
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

  // === 匯入資料 ===
  async importData(dataToImport, isTrusted) {
    if (!dataToImport) return 0;
    const now = Date.now();
    
    // 1. 取得設定 & 計算強制過期時間
    const settings = await this._getSettings();
    const ttlMs = settings.ttlDays * 24 * 60 * 60 * 1000;
    const forcedExpiredTs = now - ttlMs - (10 * 60 * 1000);
    
    // 2. 準備候選資料
    const candidates = []; 

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

      candidates.push({
          key: key,
          val: { name: name, subs: entry.subs || 0, ts: finalTs }
      });
    }

    if (candidates.length === 0) return 0;

    // 3. 批量讀取本地舊資料
    const keysToCheck = candidates.map(c => c.key);
    let currentValues = [];
    try {
        currentValues = await idbKeyval.getMany(keysToCheck);
    } catch (e) {
        currentValues = new Array(candidates.length).fill(undefined);
    }
    
    const entriesToWrite = [];

    // 4. 逐筆比對邏輯
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const localData = currentValues[i];

        // 如果本地完全沒資料，直接寫入 (沒什麼好猶豫的)
        if (!localData) {
            entriesToWrite.push([candidate.key, candidate.val]);
            continue;
        }

        // --- 比對邏輯開始 ---
        
        const localHasSubs = localData.subs && localData.subs > 0;

        // [規則 A - 絕對保護]：
        // 只要本地端已經有訂閱數，無論匯入檔是什麼狀況 (比較新、也有訂閱數、名字不同...)
        // 一律「跳過」，堅持保留本地資料。
        if (localHasSubs) {
            continue; // 跳過寫入 -> 保留本地
        }

        // [規則 B]：只有在「本地沒有訂閱數」的情況下，我們才考慮更新
        // 這時比對時間：如果本地資料雖然沒訂閱數，但時間比較新 (例如剛抓到的)，也保留本地。
        if (localData.ts > candidate.val.ts) {
            continue; // 跳過寫入 -> 保留本地
        }

        // --- 比對邏輯結束 ---

        // 只有當：
        // 1. 本地沒資料
        // 2. 本地有資料但沒訂閱數，且匯入檔比較新 (或匯入檔有訂閱數)
        // 才會執行覆蓋。
        entriesToWrite.push([candidate.key, candidate.val]);
    }

    if (entriesToWrite.length === 0) return 0;

    // 5. 寫入資料庫
    if (idbKeyval.setMany) {
      await idbKeyval.setMany(entriesToWrite);
    } else {
      await Promise.all(entriesToWrite.map(([k, v]) => idbKeyval.set(k, v)));
    }
    
    // 6. 清除快取
    const writtenKeys = entriesToWrite.map(e => e[0]);
    chrome.runtime.sendMessage({ type: "CACHE_INVALIDATE", handles: writtenKeys });
    
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
