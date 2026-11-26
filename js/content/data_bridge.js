// ===========================================================
// data_bridge.js - 前台數據橋樑
// 用途：前台頁面與背景服務的單一窗口。
// 職責：整合快取查詢與網路請求，提供統一的 getData 介面給 Scanner 使用。
// ===========================================================

const DataBridge = {
  // 讓 Scanner 知道是否過期 (用於決定 UI 樣式)
  currentTTL: daysToMs(window.AppConfig.DEFAULT_TTL_DAYS),
  // 需要知道後端保險絲狀態，因為這決定了是否能發送網路請求
  fuseBackendStatus: "NORMAL",

  // 頁內記憶體快取與進行中請求去重：同一人連續發言不重複發 IPC
  MAX_PAGE_CACHE: 2000,
  pageCache: new Map(), // normHandle -> { name, subs, ts }
  inFlight: new Map(), // normHandle -> { handle, waiters, elements, stage: "cache" | "queued" | "net" }
  refreshing: new Map(), // normHandle -> [callback, ...]

  // 網路抓取：這個頁框同時送往背景的請求上限。背景本身另有節流與併發限制，
  // 這裡只確保背景的佇列裡永遠是「現在最需要的名稱」，也讓聊天室與留言區各自有份、不會互相卡住。
  NET_SLOTS: 4,
  NEAR_MARGIN: "100% 0px",
  // 挑選順序 (每個頁框各自決定)：
  // - "newest"：最新出現的先抓 (直播聊天室：最新訊息在最下面，舊訊息很快就捲走)
  // - "oldest"：依頁面順序由上往下 (影片與 Shorts 留言區)
  ORDER: (() => {
    try {
      return typeof location !== "undefined" && location.pathname.startsWith("/live_chat") ? "newest" : "oldest";
    } catch (e) {
      return "oldest";
    }
  })(),
  netActive: 0,
  pumpTimer: null,
  io: null, // null = 尚未建立, false = 不支援
  nearState: new WeakMap(), // element -> 是否在畫面內或附近
  observedRefs: new Map(), // element -> 有幾筆查詢在等它

  init: function () {
    this.syncSettings();
  },

  syncSettings: function () {
    const { SETTINGS_KEY, FUSE_BE_KEY } = window.AppConfig;

    chrome.storage.local.get([SETTINGS_KEY, FUSE_BE_KEY], (res) => {
      this.updateTTL(res[SETTINGS_KEY]);
      if (res[FUSE_BE_KEY]) this.fuseBackendStatus = res[FUSE_BE_KEY].status;
    });

    // 監聽變化
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes[SETTINGS_KEY]) {
          this.updateTTL(changes[SETTINGS_KEY].newValue);
        }
        // 監聽後端保險絲
        if (changes[FUSE_BE_KEY]) {
          this.fuseBackendStatus =
            changes[FUSE_BE_KEY].newValue?.status || "NORMAL";
        }
      }
    });
  },

  updateTTL: function (settings) {
    const days =
      settings && settings.ttlDays
        ? settings.ttlDays
        : window.AppConfig.DEFAULT_TTL_DAYS;
    this.currentTTL = daysToMs(days);
  },

  normalizeKey: function (handle) {
    return String(handle || "").trim().toLowerCase();
  },

  rememberPageCache: function (key, entry) {
    if (this.pageCache.has(key)) this.pageCache.delete(key);
    else if (this.pageCache.size >= this.MAX_PAGE_CACHE) {
      this.pageCache.delete(this.pageCache.keys().next().value);
    }
    this.pageCache.set(key, entry);
  },

  decodeName: function (raw) {
    let finalName = raw;
    if (typeof decodeHtmlEntities === "function") {
      finalName = decodeHtmlEntities(finalName);
    }
    return finalName;
  },

  // === 核心方法：獲取資料 ===
  // 參數：
  // - handle: 要查詢的 ID
  // - callback: 當拿到資料時執行的函式 (data) => void
  // - element: (選填) 顯示這個名稱的元素；網路抓取會優先處理畫面內與附近的元素
  //
  // 順序：頁內快取 -> 背景快取 (記憶體 / IndexedDB，不排隊、不受網路限制) -> 網路抓取。
  // 網路抓取在這個頁框內最多同時送出 NET_SLOTS 筆，挑選順序是畫面內與附近的名稱優先 (先後見 ORDER)，
  // 離畫面很遠的名稱等捲動到附近才抓，已經離開頁面的名稱不再抓。
  getData: function (handle, callback, element) {
    if (!handle || typeof callback !== "function") return;
    const key = this.normalizeKey(handle);
    if (!key) return;

    // 1. 頁內快取直接命中 (0 IPC)
    const local = this.pageCache.get(key);
    if (local) {
      const isExpired = Date.now() - (local.ts || 0) > this.currentTTL;
      callback({ name: local.name, subs: local.subs || 0, isExpired });
      if (isExpired && this.fuseBackendStatus === "NORMAL") {
        this.scheduleRefresh(handle, key, callback);
      }
      return;
    }

    // 2. 同一個 handle 正在查詢中：合併等待，避免重複發送 IPC
    const existing = this.inFlight.get(key);
    if (existing) {
      // 同一個元素重複掃描時只保留一個等待者，避免資料回來後重複渲染
      if (element && existing.elements.has(element)) return;
      existing.waiters.push(callback);
      this.trackElement(existing, element);
      if (existing.stage === "queued") this.schedulePump();
      return;
    }

    const entry = {
      handle,
      key,
      waiters: [callback],
      elements: new Set(),
      anyWithoutElement: false,
      stage: "cache",
    };
    this.trackElement(entry, element);
    this.inFlight.set(key, entry);

    // 3. 先只查背景快取：命中就立刻顯示，不必排在網路抓取後面
    this.sendResolve(entry, true);
  },

  trackElement: function (entry, element) {
    if (!element || typeof element !== "object") {
      entry.anyWithoutElement = true;
      return;
    }
    if (entry.elements.has(element)) return;
    entry.elements.add(element);
    const io = this.getObserver();
    if (!io) return;
    const refs = this.observedRefs.get(element) || 0;
    if (refs === 0) {
      try {
        io.observe(element);
      } catch (e) {
        // 無法追蹤位置的元素照舊直接抓取
        entry.anyWithoutElement = true;
        return;
      }
    }
    this.observedRefs.set(element, refs + 1);
  },

  releaseElements: function (entry) {
    const io = this.io;
    entry.elements.forEach((el) => {
      const refs = (this.observedRefs.get(el) || 0) - 1;
      if (refs > 0) {
        this.observedRefs.set(el, refs);
        return;
      }
      this.observedRefs.delete(el);
      this.nearState.delete(el);
      if (io) {
        try {
          io.unobserve(el);
        } catch (e) {}
      }
    });
    entry.elements.clear();
  },

  // 畫面內與附近 (上下各一個畫面高) 的判斷；沒有 IntersectionObserver 時全部視為畫面內
  getObserver: function () {
    if (this.io !== null) return this.io;
    if (typeof IntersectionObserver !== "function") {
      this.io = false;
      return false;
    }
    try {
      const opts = { rootMargin: this.NEAR_MARGIN };
      // 聊天室在 iframe 內：以 iframe 自己的畫面為準，邊界設定才會生效
      try {
        if (typeof window !== "undefined" && window.top !== window && typeof document !== "undefined") {
          opts.root = document;
        }
      } catch (e) {}
      this.io = new IntersectionObserver((entries) => {
        entries.forEach((en) => this.nearState.set(en.target, en.isIntersecting));
        this.schedulePump();
      }, opts);
    } catch (e) {
      this.io = false;
    }
    return this.io;
  },

  // 元素仍在頁面上、且還在顯示這個 handle
  elementWants: function (el, key) {
    if (!el.isConnected) return false;
    const target = el.dataset && el.dataset.rnTargetHandle;
    return !target || this.normalizeKey(target) === key;
  },

  // 0 = 畫面內或附近 (立刻抓)、1 = 無法判斷位置 (照舊抓，但排在後面)、2 = 離畫面很遠 (先不抓)、-1 = 已沒有人需要
  entryTier: function (entry) {
    if (entry.anyWithoutElement || !this.io) return 0;
    let best = -1;
    entry.elements.forEach((el) => {
      if (best === 0) return;
      if (!this.elementWants(el, entry.key)) return;
      const near = this.nearState.get(el);
      if (near === true) {
        best = 0;
        return;
      }
      if (near === undefined) {
        // 還沒收到第一次位置回報，稍後 observer 回報時再決定
        if (best === -1) best = 2;
        return;
      }
      // 沒有版面 (例如被隱藏的區塊) 無法判斷遠近，維持原本會抓取的行為
      const tier = el.getClientRects().length === 0 ? 1 : 2;
      if (best === -1 || tier < best) best = tier;
    });
    return best;
  },

  schedulePump: function () {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, 0);
  },

  pump: function () {
    if (this.netActive >= this.NET_SLOTS) return;
    const picks = { 0: [], 1: [] };
    const dropped = [];
    this.inFlight.forEach((entry) => {
      if (entry.stage !== "queued") return;
      const tier = this.entryTier(entry);
      if (tier === -1) dropped.push(entry);
      else if (tier === 0 || tier === 1) picks[tier].push(entry);
    });
    dropped.forEach((entry) => this.finish(entry, null));
    if (this.ORDER === "newest") {
      picks[0].reverse();
      picks[1].reverse();
    }
    const ordered = picks[0].concat(picks[1]);
    for (const entry of ordered) {
      if (this.netActive >= this.NET_SLOTS) break;
      this.sendResolve(entry, false);
    }
  },

  sendResolve: function (entry, cacheOnly) {
    const key = entry.key;
    if (!cacheOnly) {
      if (this.fuseBackendStatus !== "NORMAL") {
        this.finish(entry, null);
        return;
      }
      entry.stage = "net";
      this.netActive++;
    }
    const msg = {
      type: "RESOLVE_CHANNEL_INFO",
      handle: entry.handle,
      ttlMs: this.currentTTL,
    };
    if (cacheOnly) msg.cacheOnly = true;
    else msg.priority = "normal";

    const done = (response) => {
      if (!cacheOnly) {
        this.netActive = Math.max(0, this.netActive - 1);
        this.schedulePump();
      }
      if (this.inFlight.get(key) !== entry) return;

      if (chrome.runtime.lastError || !response || !response.success) {
        if (cacheOnly && response && response.miss && this.fuseBackendStatus === "NORMAL") {
          // 背景快取沒有：排入網路抓取，由 pump 依畫面位置決定順序
          entry.stage = "queued";
          this.schedulePump();
          return;
        }
        this.finish(entry, null);
        return;
      }

      const rawName = response.fromCache ? response.name : response.nameRaw;
      const finalName = response.fromCache ? rawName : this.decodeName(rawName);
      if (!finalName || finalName === "YouTube") {
        this.finish(entry, null);
        return;
      }

      const ts = response.ts || Date.now();
      const subs = response.subs || 0;
      const isExpired = response.isExpired === true;

      this.rememberPageCache(key, { name: finalName, subs, ts });
      const waiters = this.finish(entry, { name: finalName, subs, isExpired });

      if (isExpired && this.fuseBackendStatus === "NORMAL") {
        waiters.forEach((cb) => this.scheduleRefresh(entry.handle, key, cb));
      }
    };

    try {
      chrome.runtime.sendMessage(msg, done);
    } catch (e) {
      if (!cacheOnly) {
        this.netActive = Math.max(0, this.netActive - 1);
        this.schedulePump();
      }
      this.finish(entry, null);
    }
  },

  // 回覆並移除一筆查詢的所有等待者
  finish: function (entry, payload) {
    if (this.inFlight.get(entry.key) === entry) this.inFlight.delete(entry.key);
    this.releaseElements(entry);
    const waiters = entry.waiters;
    entry.waiters = [];
    waiters.forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {}
    });
    return waiters;
  },

  // 過期資料的背景低優先級更新（同 handle 去重）
  scheduleRefresh: function (handle, key, callback) {
    if (this.refreshing.has(key)) {
      this.refreshing.get(key).push(callback);
      return;
    }
    this.refreshing.set(key, [callback]);
    this.fetchBackground(handle, "low", (fresh) => {
      const waiters = this.refreshing.get(key) || [];
      this.refreshing.delete(key);
      if (!fresh) return;
      this.rememberPageCache(key, {
        name: fresh.name,
        subs: fresh.subs || 0,
        ts: Date.now(),
      });
      waiters.forEach((cb) => cb(fresh));
    });
  },

  // === 內部：查詢快取 (保留給外部/舊呼叫相容) ===
  queryCache: function (handle) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "CACHE_GET", handle: handle },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
            return;
          }
          const ts = response.ts || 0;
          const isExpired = Date.now() - ts > this.currentTTL;

          resolve({
            name: response.name,
            subs: response.subs || 0,
            isExpired: isExpired,
          });
        }
      );
    });
  },

  // 找到 fetchBackground 方法
  fetchBackground: function (handle, priority, callback) {
    const isExpiredUpdate = priority === "low";

    chrome.runtime.sendMessage(
      {
        type: "FETCH_CHANNEL_INFO",
        handle: handle,
        priority: priority,
        refresh: isExpiredUpdate,
      },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          if (typeof callback === "function") {
            callback(null);
          }
          return;
        }

        const finalName = this.decodeName(response.nameRaw);
        if (!finalName || finalName === "YouTube") {
          if (typeof callback === "function") callback(null);
          return;
        }

        callback({
          name: finalName,
          subs: response.subs || 0,
          isExpired: false,
        });
      }
    );
  },
};
DataBridge.init();
