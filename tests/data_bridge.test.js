const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadDataBridge(extra = {}) {
  const sent = [];
  const pendingReplies = [];
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        pendingReplies.push({ msg, cb });
      },
    },
    storage: {
      local: { get: (_keys, cb) => cb({}) },
      onChanged: { addListener: () => {} },
    },
  };
  const windowObj = {
    AppConfig: {
      DEFAULT_TTL_DAYS: 15,
      SETTINGS_KEY: "settings",
      FUSE_BE_KEY: "fuse_be",
    },
  };
  const ctx = vm.createContext({
    window: windowObj,
    chrome,
    daysToMs: (d) => d * 86400 * 1000,
    decodeHtmlEntities: (s) => String(s || "").replace(/&amp;/g, "&"),
    Date,
    console,
    setTimeout,
    clearTimeout,
    ...extra,
  });
  const src = fs.readFileSync(
    path.resolve(__dirname, "../js/content/data_bridge.js"),
    "utf8"
  );
  vm.runInContext(`${src}\nthis.DataBridge = DataBridge;`, ctx);
  return { DataBridge: ctx.DataBridge, sent, pendingReplies };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const MISS = { success: false, miss: true };


test("DataBridge：同一 handle 同時多次查詢合併成單次 RESOLVE_CHANNEL_INFO，命中後走頁內快取零 IPC", async () => {
  const { DataBridge, sent, pendingReplies } = loadDataBridge();
  const got = [];

  DataBridge.getData("@Alice", (d) => got.push(["a1", d]));
  DataBridge.getData("@alice", (d) => got.push(["a2", d]));
  DataBridge.getData("@ALICE", (d) => got.push(["a3", d]));

  // 先只查背景快取
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "RESOLVE_CHANNEL_INFO");
  assert.equal(sent[0].cacheOnly, true);

  // 快取未命中後才送網路抓取 (頁面上的名稱用 normal 優先級)
  pendingReplies.shift().cb(MISS);
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].cacheOnly, undefined);
  assert.equal(sent[1].priority, "normal");

  pendingReplies.shift().cb({
    success: true,
    fromCache: false,
    nameRaw: "Alice &amp; Co",
    subs: 5000,
    ts: Date.now(),
    isExpired: false,
  });

  assert.equal(got.length, 3);
  assert.deepEqual({ ...got[0][1] }, { name: "Alice & Co", subs: 5000, isExpired: false });
  assert.deepEqual({ ...got[2][1] }, { name: "Alice & Co", subs: 5000, isExpired: false });

  // 再次查詢同一人直接命中頁內快取，不發送任何 IPC
  DataBridge.getData("@alice", (d) => got.push(["a4", d]));
  assert.equal(sent.length, 2);
  assert.deepEqual({ ...got[3][1] }, { name: "Alice & Co", subs: 5000, isExpired: false });
});

test("DataBridge：過期快取先回傳舊名稱並去重背景更新，更新完成後刷新頁內快取", () => {
  const { DataBridge, sent, pendingReplies } = loadDataBridge();
  const got = [];

  DataBridge.getData("@bob", (d) => got.push(["b1", d]));
  DataBridge.getData("@bob", (d) => got.push(["b2", d]));
  assert.equal(sent.length, 1);

  pendingReplies.shift().cb({
    success: true,
    fromCache: true,
    name: "Old Bob",
    subs: 1000,
    ts: Date.now() - 30 * 86400 * 1000,
    isExpired: true,
  });

  // 兩個呼叫者先收到過期快取，且只發一次低優先級 FETCH_CHANNEL_INFO
  assert.equal(got.length, 2);
  assert.equal(got[0][1].name, "Old Bob");
  assert.equal(got[0][1].isExpired, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, "FETCH_CHANNEL_INFO");
  assert.equal(sent[1].priority, "low");

  pendingReplies.shift().cb({
    success: true,
    nameRaw: "New Bob",
    subs: 2000,
  });

  assert.equal(got.length, 4);
  assert.deepEqual({ ...got[2][1] }, { name: "New Bob", subs: 2000, isExpired: false });
  assert.deepEqual({ ...got[3][1] }, { name: "New Bob", subs: 2000, isExpired: false });
});

test("DataBridge：快取命中不佔網路名額，網路抓取每個頁框最多同時 NET_SLOTS 筆", async () => {
  const { DataBridge, sent, pendingReplies } = loadDataBridge();
  const got = [];
  for (let i = 0; i < 10; i++) DataBridge.getData(`@u${i}`, (d) => got.push([i, d]));
  assert.equal(sent.length, 10);
  assert.ok(sent.every((m) => m.cacheOnly === true));

  // u0 在快取裡，其餘未命中
  const cacheReplies = pendingReplies.splice(0, 10);
  cacheReplies[0].cb({ success: true, fromCache: true, name: "Zero", subs: 1, ts: Date.now(), isExpired: false });
  cacheReplies.slice(1).forEach((r) => r.cb(MISS));
  assert.equal(got.length, 1);
  assert.equal(got[0][1].name, "Zero");

  await tick();
  const net = sent.slice(10);
  assert.equal(net.length, DataBridge.NET_SLOTS);
  // 依出現順序送出
  assert.deepEqual(net.map((m) => m.handle), ["@u1", "@u2", "@u3", "@u4"]);

  // 一筆回來就補下一筆
  pendingReplies.shift().cb({ success: true, fromCache: false, nameRaw: "One", subs: 0 });
  await tick();
  assert.equal(sent.length, 15);
  assert.equal(sent[14].handle, "@u5");
});

function fakeIO() {
  const observers = [];
  class IO {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      observers.push(this);
    }
    observe(el) {
      this.targets.add(el);
    }
    unobserve(el) {
      this.targets.delete(el);
    }
    report(el, near) {
      this.cb([{ target: el, isIntersecting: near }]);
    }
  }
  return { IO, observers };
}

function fakeEl(handle, { hasBox = true } = {}) {
  return {
    isConnected: true,
    dataset: { rnTargetHandle: handle },
    getClientRects: () => (hasBox ? [{}] : []),
  };
}

test("DataBridge：畫面內與附近的名稱先抓，遠處的等捲到附近，已離開頁面的不抓", async () => {
  const { IO, observers } = fakeIO();
  const { DataBridge, sent, pendingReplies } = loadDataBridge({ IntersectionObserver: IO });
  DataBridge.NET_SLOTS = 2;

  const far = fakeEl("@far");
  const near1 = fakeEl("@near1");
  const near2 = fakeEl("@near2");
  const gone = fakeEl("@gone");
  const hidden = fakeEl("@hidden", { hasBox: false });
  for (const el of [far, near1, gone, near2, hidden]) {
    DataBridge.getData(el.dataset.rnTargetHandle, () => {}, el);
  }
  pendingReplies.splice(0).forEach((r) => r.cb(MISS));
  await tick();
  // 位置還沒回報前不送出
  assert.equal(sent.length, 5);

  const io = observers[0];
  io.report(far, false);
  io.report(near1, true);
  io.report(near2, true);
  io.report(hidden, false);
  gone.isConnected = false;
  io.report(gone, false);
  await tick();

  // 先送畫面內的兩筆 (名額 2)
  assert.deepEqual(sent.slice(5).map((m) => m.handle), ["@near1", "@near2"]);
  // 已離開頁面的名稱直接放棄，不再追蹤
  assert.equal(DataBridge.inFlight.has("@gone"), false);
  assert.equal(io.targets.has(gone), false);

  // 名額空出：沒有版面可判斷的照舊抓，遠處的繼續等
  pendingReplies.shift().cb({ success: true, fromCache: false, nameRaw: "N1", subs: 0 });
  await tick();
  assert.deepEqual(sent.slice(7).map((m) => m.handle), ["@hidden"]);

  pendingReplies.shift().cb({ success: true, fromCache: false, nameRaw: "N2", subs: 0 });
  await tick();
  assert.equal(sent.length, 8);

  // 捲動到附近後才抓
  io.report(far, true);
  await tick();
  assert.equal(sent[8].handle, "@far");
});

test("DataBridge：同一元素重複掃描只保留一個等待者", async () => {
  const { DataBridge, sent, pendingReplies } = loadDataBridge();
  const el = fakeEl("@dup");
  let calls = 0;
  DataBridge.getData("@dup", () => calls++, el);
  DataBridge.getData("@dup", () => calls++, el);
  DataBridge.getData("@dup", () => calls++, el);
  pendingReplies.shift().cb({ success: true, fromCache: true, name: "Dup", subs: 0, ts: Date.now() });
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
});

test("DataBridge：直播聊天室最新的先抓，留言區由上往下", async () => {
  for (const [pathname, expected] of [
    ["/live_chat", ["@m9", "@m8", "@m7", "@m6"]],
    ["/watch", ["@m1", "@m2", "@m3", "@m4"]],
  ]) {
    const { DataBridge, sent, pendingReplies } = loadDataBridge({ location: { pathname } });
    assert.equal(DataBridge.ORDER, pathname === "/live_chat" ? "newest" : "oldest");
    for (let i = 0; i < 10; i++) DataBridge.getData(`@m${i}`, () => {});
    // m0 先單獨送出並佔一個名額，再一次進來 9 筆
    pendingReplies.shift().cb(MISS);
    await tick();
    pendingReplies.splice(0, 9).forEach((r) => r.cb(MISS));
    await tick();
    const net = sent.slice(10).map((m) => m.handle);
    assert.equal(net[0], "@m0");
    // 剩下 3 個名額
    assert.deepEqual(net.slice(1), expected.slice(0, 3), pathname);
  }
});
