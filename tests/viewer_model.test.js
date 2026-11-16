const test = require("node:test");
const assert = require("node:assert/strict");
const { ViewerIndex, FORMAT, normalizeHandle, normalizeRecord } = require("../js/shared/viewer_model.js");

const UC_A = "UC" + "a".repeat(22);
const UC_B = "UC" + "b".repeat(22);
const TAGS = [
  { id: "t1", label: "常客", color: "#FF0000" },
  { id: "t2", label: "繪師", color: "nope" },
];

function fresh() {
  return new ViewerIndex().load([], TAGS);
}

test("handle 正規化：補上 @、轉小寫、拒絕空白", () => {
  assert.equal(normalizeHandle("Ming"), "@ming");
  assert.equal(normalizeHandle(" @Ming "), "@ming");
  assert.equal(normalizeHandle("@a b"), null);
  assert.equal(normalizeHandle(""), null);
});

test("沒有任何識別碼的紀錄無效", () => {
  assert.equal(normalizeRecord({ customNickname: "x" }), null);
  assert.equal(normalizeRecord({ channelId: "UCshort", customNickname: "x" }), null);
});

test("標籤定義：顏色轉小寫，格式不符的顏色清空", () => {
  const idx = fresh();
  assert.deepEqual(idx.tags, [
    { id: "t1", label: "常客", color: "#ff0000" },
    { id: "t2", label: "繪師", color: "" },
  ]);
});

test("貼標籤、加備註、加減分", () => {
  const idx = fresh();
  idx.patch({ handle: "@Ming" }, { addTagId: "t1" }, 1000);
  idx.patch({ handle: "@ming" }, { addNote: " 喜歡貓 " }, 2000);
  const { record } = idx.patch({ handle: "@ming" }, { scoreDelta: 2 }, 3000);
  assert.deepEqual(record.tagIds, ["t1"]);
  assert.deepEqual(record.notes, ["喜歡貓"]);
  assert.equal(record.score, 2);
  assert.equal(record.updatedAt, 3000);
  assert.equal(record.key, "@ming");
  assert.equal(idx.size, 1);
});

test("不存在的標籤 id 不會被存入", () => {
  const idx = fresh();
  const { record } = idx.patch({ handle: "@a" }, { tagIds: ["t1", "ghost"] });
  assert.deepEqual(record.tagIds, ["t1"]);
});

test("重複的備註與標籤只保留一份", () => {
  const idx = fresh();
  idx.patch({ handle: "@a" }, { addNote: "x" });
  const { record } = idx.patch({ handle: "@a" }, { addNote: "x", addTagId: "t1" });
  idx.patch({ handle: "@a" }, { addTagId: "t1" });
  assert.deepEqual(record.notes, ["x"]);
  assert.deepEqual(idx.find({ handle: "@a" }).tagIds, ["t1"]);
});

test("內容清空的紀錄會被移除", () => {
  const idx = fresh();
  idx.patch({ handle: "@a" }, { addNote: "x" });
  const res = idx.patch({ handle: "@a" }, { removeNote: "x" });
  assert.equal(res.record, null);
  assert.deepEqual(res.removedKeys, ["@a"]);
  assert.equal(idx.size, 0);
});

test("知道 channel id 後改以 channel id 為主鍵，舊主鍵列入刪除", () => {
  const idx = fresh();
  idx.patch({ handle: "@ming" }, { customNickname: "小明" }, 1000);
  const res = idx.patch({ channelId: UC_A, handle: "@ming" }, { scoreDelta: 1 }, 2000);
  assert.equal(res.record.key, UC_A);
  assert.equal(res.record.customNickname, "小明");
  assert.deepEqual(res.removedKeys, ["@ming"]);
  assert.equal(idx.size, 1);
  // 之後只憑 handle 或只憑 channel id 都找得到
  assert.equal(idx.find({ handle: "@MING" }).key, UC_A);
  assert.equal(idx.find({ channelId: UC_A }).key, UC_A);
});

test("channel id 優先：handle 相同但 channel id 不同視為不同人", () => {
  const idx = fresh();
  idx.patch({ channelId: UC_A, handle: "@same" }, { addNote: "A" });
  assert.equal(idx.find({ channelId: UC_B, handle: "@same" }), null);
  idx.patch({ channelId: UC_B, handle: "@same" }, { addNote: "B" });
  assert.equal(idx.size, 2);
  assert.deepEqual(idx.find({ channelId: UC_A }).notes, ["A"]);
});

test("觀眾更名後以 channel id 找到同一筆並更新 handle", () => {
  const idx = fresh();
  idx.patch({ channelId: UC_A, handle: "@old" }, { addNote: "n" });
  const { record } = idx.patch({ channelId: UC_A, handle: "@new" }, { scoreDelta: 1 });
  assert.equal(record.handle, "@new");
  assert.equal(idx.size, 1);
});

test("handle 紀錄與既有的 channel id 紀錄合併", () => {
  const idx = fresh();
  idx.patch({ channelId: UC_A }, { addNote: "from-cid", scoreDelta: 2, customNickname: "舊", nicknameAt: 10 }, 10);
  idx.patch({ handle: "@ming" }, { addNote: "from-handle", scoreDelta: 3, customNickname: "新", nicknameAt: 20 }, 20);
  const { record } = idx.patch({ channelId: UC_A, handle: "@ming" }, {}, 30);
  assert.equal(idx.size, 1);
  assert.deepEqual(record.notes.sort(), ["from-cid", "from-handle"]);
  assert.equal(record.score, 5);
  assert.equal(record.customNickname, "新");
});

test("刪除標籤定義時，觀眾身上的標籤一併移除", () => {
  const idx = fresh();
  idx.patch({ handle: "@a" }, { addTagId: "t1" });
  idx.patch({ handle: "@b" }, { addTagId: "t1", addNote: "keep" });
  const res = idx.setTags([TAGS[1]]);
  assert.deepEqual(res.removedKeys, ["@a"]);
  assert.equal(res.changed.length, 1);
  assert.deepEqual(idx.find({ handle: "@b" }).tagIds, []);
});

test("匯出後以取代模式匯入可完整還原", () => {
  const idx = fresh();
  idx.patch({ channelId: UC_A, handle: "@ming" }, { customNickname: "小明", addTagId: "t1", addNote: "n1", score: 7 }, 5000);
  idx.patch({ handle: "@only" }, { addNote: "n2" }, 6000);
  const data = JSON.parse(JSON.stringify(idx.exportData(9000)));
  assert.equal(data.format, FORMAT);

  const restored = new ViewerIndex().load([], []);
  const result = restored.importData(data, "replace");
  assert.deepEqual(result, { imported: 2, skipped: 0 });
  assert.deepEqual(restored.exportData(9000), idx.exportData(9000));
});

test("合併匯入：備註與標籤取聯集，評分以檔案為準，暱稱取較新者", () => {
  const idx = fresh();
  idx.patch({ channelId: UC_A }, { addNote: "local", addTagId: "t1", score: 1, customNickname: "本機", nicknameAt: 50 }, 50);
  idx.importData(
    {
      format: FORMAT,
      tags: [{ id: "t3", label: "新標籤", color: "#00ff00" }],
      viewers: [
        { channelId: UC_A, notes: ["file"], tagIds: ["t3"], score: 9, customNickname: "檔案", nicknameAt: 10, updatedAt: 10 },
        { handle: "bad handle" },
        { handle: "@empty" },
      ],
    },
    "merge"
  );
  const rec = idx.find({ channelId: UC_A });
  assert.deepEqual(rec.notes.sort(), ["file", "local"]);
  assert.deepEqual(rec.tagIds.sort(), ["t1", "t3"]);
  assert.equal(rec.score, 9);
  assert.equal(rec.customNickname, "本機");
  assert.equal(idx.tags.length, 3);
  assert.equal(idx.size, 1);
});

test("格式不符的檔案會被拒絕，且不影響現有資料", () => {
  const idx = fresh();
  idx.patch({ handle: "@a" }, { addNote: "x" });
  assert.throws(() => idx.importData({ format: "other", viewers: [] }, "replace"), /format/);
  assert.throws(() => idx.importData(null), /format/);
  assert.equal(idx.size, 1);
});

test("匯入檔的外部資料欄位不會被採用，欄位長度會被截斷", () => {
  const idx = fresh();
  idx.importData({
    format: FORMAT,
    tags: [],
    viewers: [{ handle: "@a", customNickname: "x".repeat(200), ext: { aiTags: ["注入"] } }],
  });
  const rec = idx.find({ handle: "@a" });
  assert.equal(rec.customNickname.length, 50);
  assert.equal(rec.ext, null);
});

test("外部唯讀資料：可寫入、不更新修改時間、空內容視為無", () => {
  const idx = fresh();
  idx.patch({ channelId: UC_A }, { addNote: "n" }, 100);
  const { record } = idx.patch(
    { channelId: UC_A },
    { ext: { tags: [{ label: "雲端", color: "#123456" }], aiTags: ["愛貓"], name: "Ming" }, silent: true },
    999
  );
  assert.equal(record.updatedAt, 100);
  assert.deepEqual(record.ext, { tags: [{ label: "雲端", color: "#123456" }], aiTags: ["愛貓"], name: "Ming" });
  // 只有外部資料的觀眾也會保留
  const only = idx.patch({ channelId: UC_B }, { ext: { aiTags: ["x"] }, silent: true });
  assert.equal(only.record.key, UC_B);
  assert.equal(idx.patch({ channelId: UC_B }, { ext: { aiTags: [] } }).record, null);
});
