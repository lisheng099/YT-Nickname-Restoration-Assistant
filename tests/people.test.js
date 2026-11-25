// 觀眾資料頁：名稱快取與自訂暱稱 / 備註合成一份清單、搜尋、篩選、排序與新增時的身分解析
const test = require("node:test");
const assert = require("node:assert/strict");
require("../js/shared/notes_core.js");
const People = require("../pages/manager/people.js");

const UC = (c) => "UC" + String(c).repeat(22);

const cache = [
  { id: "@sakura", name: "さくら🌸", subs: 1200, ts: 100, cid: UC("a"), isExpired: false, daysUntilDelete: 0 },
  { id: "@momo", name: "Momo", subs: 0, ts: 300, isExpired: true, daysUntilDelete: 5 },
  { id: "@plain", name: "Plain Viewer", subs: 50, ts: 200, isExpired: false, daysUntilDelete: 0 },
];
const notes = [
  // 以頻道 ID 為主鍵、handle 已改名：仍應對上 @sakura 這筆快取 (頻道 ID 優先)
  { key: UC("a"), channelId: UC("a"), handle: "@sakura_old", customNickname: "小櫻", notes: ["喜歡貓"], updatedAt: 50 },
  // 只有 handle 的舊紀錄
  { key: "@momo", channelId: null, handle: "@momo", customNickname: "", notes: ["常客"], updatedAt: 400 },
  // 沒有快取的人 (例如手動新增)
  { key: "@offline", channelId: null, handle: "@offline", customNickname: "下播補寫", notes: [], updatedAt: 10 },
];

test("buildRows：每人一列，快取以頻道 ID 優先、handle 備用對上筆記，沒快取的筆記也列出", () => {
  const rows = People.buildRows(cache, notes);
  assert.equal(rows.length, 4);
  const byKey = Object.fromEntries(rows.map((r) => [r.rowKey, r]));
  assert.equal(byKey["c:@sakura"].note.customNickname, "小櫻");
  assert.equal(byKey["c:@sakura"].channelId, UC("a"));
  assert.deepEqual(byKey["c:@momo"].note.notes, ["常客"]);
  assert.equal(byKey["c:@momo"].recent, 400);
  assert.equal(byKey["c:@plain"].note, null);
  const offline = byKey["n:@offline"];
  assert.equal(offline.inCache, false);
  assert.equal(offline.handle, "@offline");
  assert.equal(offline.name, "");
});

test("filterRows：搜尋名稱、@handle、頻道 ID、暱稱與備註，並可篩選有筆記 / 只有快取", () => {
  const rows = People.buildRows(cache, notes);
  const keys = (list) => list.map((r) => r.rowKey).sort();
  assert.deepEqual(keys(People.filterRows(rows, "さくら", "all")), ["c:@sakura"]);
  assert.deepEqual(keys(People.filterRows(rows, "小櫻", "all")), ["c:@sakura"]);
  assert.deepEqual(keys(People.filterRows(rows, "貓", "all")), ["c:@sakura"]);
  assert.deepEqual(keys(People.filterRows(rows, UC("a").toLowerCase(), "all")), ["c:@sakura"]);
  assert.deepEqual(keys(People.filterRows(rows, "@MOMO", "all")), ["c:@momo"]);
  assert.deepEqual(keys(People.filterRows(rows, "", "notes")), ["c:@momo", "c:@sakura", "n:@offline"]);
  assert.deepEqual(keys(People.filterRows(rows, "", "cache")), ["c:@plain"]);
});

test("sortRows：預設依最近活動，另可依名稱與訂閱數", () => {
  const rows = People.buildRows(cache, notes);
  assert.deepEqual(
    People.sortRows(rows, "recent", "desc").map((r) => r.rowKey),
    ["c:@momo", "c:@plain", "c:@sakura", "n:@offline"]
  );
  assert.equal(People.sortRows(rows, "subs", "desc")[0].rowKey, "c:@sakura");
  // 名稱排序用畫面上看到的名字 (有自訂暱稱時用暱稱)
  assert.deepEqual(
    People.sortRows(rows, "name", "asc").map((r) => r.rowKey),
    ["c:@momo", "c:@plain", "n:@offline", "c:@sakura"]
  );
});

test("parseIdentityInput：@handle、沒有 @ 的 handle、頻道 ID 與頻道網址", () => {
  assert.deepEqual(People.parseIdentityInput(" @Sakura "), { channelId: null, handle: "@sakura" });
  assert.deepEqual(People.parseIdentityInput("sakura"), { channelId: null, handle: "@sakura" });
  assert.deepEqual(People.parseIdentityInput(UC("b")), { channelId: UC("b"), handle: null });
  assert.deepEqual(People.parseIdentityInput("https://www.youtube.com/@Momo/streams"), { channelId: null, handle: "@momo" });
  assert.deepEqual(People.parseIdentityInput(`https://youtube.com/channel/${UC("c")}`), { channelId: UC("c"), handle: null });
  assert.deepEqual(
    People.parseIdentityInput("https://www.youtube.com/@%E3%81%95%E3%81%8F%E3%82%89"),
    { channelId: null, handle: "@さくら" }
  );
  // 與 fixtures/handle_cases.json 相同的形狀規則：不能有空白或 , / ? # &
  assert.equal(People.parseIdentityInput("two words"), null);
  assert.equal(People.parseIdentityInput("@a,b"), null);
  assert.equal(People.parseIdentityInput(""), null);
  assert.equal(People.parseIdentityInput("@" + "x".repeat(61)), null);
});

test("findRow：新增時輸入的身分若已在清單中，找到同一個人", () => {
  const rows = People.buildRows(cache, notes);
  assert.equal(People.findRow(rows, { channelId: UC("a"), handle: null }).rowKey, "c:@sakura");
  assert.equal(People.findRow(rows, { channelId: null, handle: "@offline" }).rowKey, "n:@offline");
  assert.equal(People.findRow(rows, { channelId: null, handle: "@nobody" }), null);
});
