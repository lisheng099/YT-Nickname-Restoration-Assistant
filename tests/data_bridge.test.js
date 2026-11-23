const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadDataBridge() {
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
  });
  const src = fs.readFileSync(
    path.resolve(__dirname, "../js/content/data_bridge.js"),
    "utf8"
  );
  vm.runInContext(`${src}\nthis.DataBridge = DataBridge;`, ctx);
  return { DataBridge: ctx.DataBridge, sent, pendingReplies };
}

test("DataBridge：同一 handle 同時多次查詢合併成單次 RESOLVE_CHANNEL_INFO，命中後走頁內快取零 IPC", () => {
  const { DataBridge, sent, pendingReplies } = loadDataBridge();
  const got = [];

  DataBridge.getData("@Alice", (d) => got.push(["a1", d]));
  DataBridge.getData("@alice", (d) => got.push(["a2", d]));
  DataBridge.getData("@ALICE", (d) => got.push(["a3", d]));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "RESOLVE_CHANNEL_INFO");

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
  assert.equal(sent.length, 1);
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
