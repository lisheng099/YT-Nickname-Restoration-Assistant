// ===========================================================
// data_manager.js - 資料存取服務層
// 用途：封裝 chrome.storage 操作、匯入匯出邏輯與資料驗證。
// ===========================================================

const DataManager = {
  CACHE_KEY: window.AppConfig.CACHE_KEY,
  TTL: window.AppConfig.TTL,
  LOCK_NAME: "yt_realname_storage_lock",

  // === 讀取與列表 ===

  // 取得所有資料 (已轉換為陣列格式供 UI 使用)
  async getAllList() {
    return new Promise((resolve) => {
      chrome.storage.local.get(this.CACHE_KEY, (res) => {
        const raw = res[this.CACHE_KEY] || {};
        const list = [];
        
        // 資料清洗：過濾無效資料並轉為陣列
        for (const [id, data] of Object.entries(raw)) {
          if (!data) continue;
          const name = data.name || (typeof data === "string" ? data : null);
          if (!name) continue;

          list.push({
            id: id,
            name: name,
            subs: data.subs || 0,
            ts: data.ts || 0
          });
        }
        resolve(list);
      });
    });
  },

  // 取得原始資料物件 (供匯出或內部使用)
  async getRawData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(this.CACHE_KEY, (res) => {
        resolve(res[this.CACHE_KEY] || {});
      });
    });
  },

  // === 寫入操作 (使用 Web Locks 保護) ===

  // 批次刪除 (支援單筆或多筆 ID)
  async deleteItems(ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0) return;

    return navigator.locks.request(this.LOCK_NAME, () => {
        return new Promise((resolve) => {
            chrome.storage.local.get(this.CACHE_KEY, (res) => {
                const raw = res[this.CACHE_KEY] || {};
                let changed = false;
                
                idArray.forEach(id => {
                    if (raw[id]) {
                        delete raw[id];
                        changed = true;
                    }
                });

                if (changed) {
                    chrome.storage.local.set({ [this.CACHE_KEY]: raw }, resolve);
                } else {
                    resolve();
                }
            });
        });
    });
  },

  // 批次過期 (支援單筆或多筆 ID)
  async expireItems(ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length === 0) return;

    return navigator.locks.request(this.LOCK_NAME, () => {
        return new Promise((resolve) => {
            chrome.storage.local.get(this.CACHE_KEY, (res) => {
                const raw = res[this.CACHE_KEY] || {};
                let changed = false;
                const pastTime = Date.now() - this.TTL - 10000; // 設定為過期時間

                idArray.forEach(id => {
                    if (raw[id]) {
                        raw[id].ts = pastTime;
                        changed = true;
                    }
                });

                if (changed) {
                    chrome.storage.local.set({ [this.CACHE_KEY]: raw }, resolve);
                } else {
                    resolve();
                }
            });
        });
    });
  },

  // 清空所有資料
  async clearAll() {
    return navigator.locks.request(this.LOCK_NAME, () => {
        return new Promise((resolve) => {
            chrome.storage.local.remove(this.CACHE_KEY, resolve);
        });
    });
  },

  // === 匯入匯出邏輯 ===

  // 產生備份資料 (含 Checksum)
  async generateBackup() {
    const raw = await this.getRawData();
    const checksum = await this._computeChecksum(raw);
    
    return {
        meta: {
            version: chrome.runtime.getManifest().version,
            generatedAt: Date.now(),
            checksum: checksum
        },
        data: raw
    };
  },

  // 驗證並匯入資料
  // isTrusted: true (信任模式, 保留時間), false (安全模式, 強制過期)
  async importData(dataToImport, isTrusted) {
    if (!dataToImport) return 0;

    const now = Date.now();
    const forcedExpiredTs = now - this.TTL - 60000;
    const cleanData = {};
    let validCount = 0;

    for (const [key, val] of Object.entries(dataToImport)) {
        const entry = val || {};
        const name = entry.name || (typeof entry === "string" ? entry : null);
        if (!name) continue;

        let finalTs;
        if (isTrusted) {
            // [信任模式] 邏輯：
            // 1. 若有訂閱數 -> 強制過期 (為了更新最新數據)
            // 2. 若時間是未來 -> 強制過期
            // 3. 其他 -> 保留原時間
            const originTs = entry.ts || now;
            const hasSubs = entry.subs && entry.subs > 0;
            
            if (originTs > now || hasSubs) {
                finalTs = forcedExpiredTs;
            } else {
                finalTs = originTs;
            }
        } else {
            // [安全模式] 全部過期
            finalTs = forcedExpiredTs;
        }

        cleanData[key] = {
            name: name,
            subs: entry.subs || 0,
            ts: finalTs
        };
        validCount++;
    }

    if (validCount === 0) return 0;

    // 寫入資料庫
    await navigator.locks.request(this.LOCK_NAME, () => {
        return new Promise((resolve) => {
            chrome.storage.local.get(this.CACHE_KEY, (res) => {
                const currentData = res[this.CACHE_KEY] || {};
                const mergedData = { ...currentData, ...cleanData };
                chrome.storage.local.set({ [this.CACHE_KEY]: mergedData }, resolve);
            });
        });
    });

    return validCount;
  },

  // 驗證 Checksum
  async verifyChecksum(json) {
      if (!json.meta || !json.data) return false; // 舊格式或無效
      const calculatedHash = await this._computeChecksum(json.data);
      return calculatedHash === json.meta.checksum;
  },

  // 內部工具：計算雜湊
  async _computeChecksum(data) {
    const orderedData = {};
    Object.keys(data).sort().forEach(key => {
        orderedData[key] = data[key];
    });
    const msgUint8 = new TextEncoder().encode(JSON.stringify(orderedData));
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
};