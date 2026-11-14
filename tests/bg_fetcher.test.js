const test = require("node:test");
const assert = require("node:assert/strict");

// --- 背景環境的最小替身 ---
const storage = {};
const storageListeners = [];
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => cb({}),
      set: (obj, cb) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          storage[k] = v;
          changes[k] = { newValue: v };
        }
        storageListeners.forEach((fn) => fn(changes, "local"));
        if (cb) cb();
      },
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
};
global.AppConfig = {
  FETCH_SPEED_KEY: "speed",
  FUSE_BE_KEY: "fuse_be",
  FUSE_CONFIG: { BACKEND_ERROR_THRESHOLD: 3 },
  NEGATIVE_CACHE: { NOT_FOUND_MS: 1000, ERROR_MS: 1000, MAX_ENTRIES: 3 },
  SPEED_PRESETS: {},
};
const noop = () => {};
global.Logger = { info: noop, green: noop, orange: noop, red: noop };
const cacheWrites = [];
global.BgCache = { set: (handle, data) => cacheWrites.push([handle, data]) };
global.YTParser = require("../js/background/yt_parser.js").YTParser;

const { BgFetcher } = require("../js/background/bg_fetcher.js");

let fetchCalls = [];
function reset(responder) {
  fetchCalls = [];
  cacheWrites.length = 0;
  BgFetcher.queue = { high: [], low: [] };
  BgFetcher.activeTasks.clear();
  BgFetcher.failedLookups.clear();
  BgFetcher.tabQuotas.clear();
  BgFetcher.consecutiveErrors = 0;
  BgFetcher.isProcessing = false;
  BgFetcher.lastFetchTime = 0;
  BgFetcher.fuseBackend = { status: "NORMAL", reason: null };
  BgFetcher.DELAY = { MIN: 0, MAX: 0 };
  BgFetcher.INITIAL_POLL_DELAY = { MIN: 0, MAX: 0 };
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return responder(url);
  };
}

const okPage = (name) => ({
  ok: true,
  status: 200,
  url: "https://www.youtube.com/@x",
  text: async () => `<meta property="og:title" content="${name}">`,
});
const status = (code) => ({
  ok: false,
  status: code,
  url: "https://www.youtube.com/@x",
  text: async () => "",
});

test("成功時寫入快取並回傳名稱", async () => {
  reset(() => okPage("Alice"));
  const result = await BgFetcher.fetch("@alice");
  assert.equal(result.success, true);
  assert.equal(result.nameRaw, "Alice");
  assert.deepEqual(cacheWrites, [["@alice", { name: "Alice", subs: 0 }]]);
});

test("大小寫不同的同一個 handle 合併為一次請求", async () => {
  reset(() => okPage("Alice"));
  const [a, b] = await Promise.all([BgFetcher.fetch("@Alice"), BgFetcher.fetch("@alice")]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(a.nameRaw, "Alice");
  assert.equal(b.nameRaw, "Alice");
});

test("404 進入失敗快取，不重複請求也不計入健康度", async () => {
  reset(() => status(404));
  const first = await BgFetcher.fetch("@ghost");
  const second = await BgFetcher.fetch("@ghost");
  assert.equal(first.notFound, true);
  assert.equal(second.notFound, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(BgFetcher.consecutiveErrors, 0);
});

test("手動強制抓取會略過失敗快取", async () => {
  reset(() => status(404));
  await BgFetcher.fetch("@ghost");
  await BgFetcher.fetch("@ghost", "high", true);
  assert.equal(fetchCalls.length, 2);
});

test("失敗快取到期後會重新請求", async () => {
  reset(() => status(404));
  await BgFetcher.fetch("@ghost");
  BgFetcher.failedLookups.get("@ghost").until = Date.now() - 1;
  await BgFetcher.fetch("@ghost");
  assert.equal(fetchCalls.length, 2);
});

test("失敗快取有筆數上限", async () => {
  reset(() => status(404));
  for (const h of ["@a1", "@a2", "@a3", "@a4"]) await BgFetcher.fetch(h);
  assert.equal(BgFetcher.failedLookups.size, 3);
  assert.equal(BgFetcher.failedLookups.has("@a1"), false);
});

test("429 每次只計一次錯誤", async () => {
  reset(() => status(429));
  await BgFetcher.fetch("@a");
  assert.equal(BgFetcher.consecutiveErrors, 1);
  await BgFetcher.fetch("@b");
  assert.equal(BgFetcher.consecutiveErrors, 2);
});

test("連線錯誤與 HTTP 5xx 計入健康度，成功後歸零", async () => {
  let mode = "throw";
  reset(() => {
    if (mode === "throw") throw new Error("network down");
    if (mode === "500") return status(500);
    return okPage("Bob");
  });
  await BgFetcher.fetch("@a");
  mode = "500";
  await BgFetcher.fetch("@b");
  assert.equal(BgFetcher.consecutiveErrors, 2);
  mode = "ok";
  await BgFetcher.fetch("@c");
  assert.equal(BgFetcher.consecutiveErrors, 0);
});

test("達到門檻時熔斷，並回覆所有等待中的請求", async () => {
  reset(() => status(429));
  const results = await Promise.all(
    ["@a", "@b", "@c", "@d", "@e"].map((h) => BgFetcher.fetch(h, "low"))
  );
  assert.equal(BgFetcher.fuseBackend.status, "TRIPPED");
  assert.equal(storage.fuse_be.status, "TRIPPED");
  assert.equal(fetchCalls.length, 3);
  assert.equal(results.filter((r) => r.error === "Fuse Tripped").length, 2);
  assert.equal(BgFetcher.activeTasks.size, 0);
  assert.equal(BgFetcher.isProcessing, false);

  const after = await BgFetcher.fetch("@f");
  assert.equal(after.error, "Fuse Tripped");
  assert.equal(fetchCalls.length, 3);
});

test("保險絲復歸後錯誤計數與失敗快取歸零", async () => {
  reset(() => status(429));
  await BgFetcher.fetch("@a");
  chrome.storage.local.set({ fuse_be: { status: "NORMAL", reason: null } });
  assert.equal(BgFetcher.consecutiveErrors, 0);
  assert.equal(BgFetcher.failedLookups.size, 0);
});

test("被導向登入頁視為失敗", async () => {
  reset(() => ({ ...okPage("x"), url: "https://consent.youtube.com/m?continue=..." }));
  const result = await BgFetcher.fetch("@a");
  assert.equal(result.error, "Redirected to login");
  assert.equal(BgFetcher.consecutiveErrors, 1);
});
