const test = require("node:test");
const assert = require("node:assert/strict");

const { ViewerNotesModel } = require("../js/background/bg_notes.js");

const UC_A = "UC" + "A".repeat(22);
const UC_B = "UC" + "b".repeat(22);

test("自訂暱稱與備註：新增、查詢、刪除與空紀錄自動清理", () => {
  const idx = ViewerNotesModel.createIndex();

  const r1 = idx.patch({ channelId: UC_A, handle: "@Alice" }, { customNickname: "  小愛  ", addNote: "常客" }, 1000);
  assert.equal(r1.record.key, UC_A);
  assert.equal(r1.record.customNickname, "小愛");
  assert.deepEqual(r1.record.notes, ["常客"]);
  assert.equal(idx.count(), 1);

  // 可用 channelId 或大小寫不敏感的 @handle 查到同一筆
  assert.equal(idx.find({ channelId: UC_A }).customNickname, "小愛");
  assert.equal(idx.find({ handle: "@ALICE" }).customNickname, "小愛");

  // 重複備註不會重複加入
  idx.patch({ channelId: UC_A }, { addNote: "常客" }, 2000);
  idx.patch({ channelId: UC_A }, { addNote: "喜歡貓" }, 2000);
  assert.deepEqual(idx.find({ channelId: UC_A }).notes, ["常客", "喜歡貓"]);

  // 移除備註與清空暱稱後，紀錄自動移除
  idx.patch({ channelId: UC_A }, { removeNote: "常客" }, 3000);
  assert.deepEqual(idx.find({ channelId: UC_A }).notes, ["喜歡貓"]);
  const cleared = idx.patch({ channelId: UC_A }, { customNickname: "", removeNote: "喜歡貓" }, 4000);
  assert.equal(cleared.record, null);
  assert.deepEqual(cleared.removedKeys, [UC_A]);
  assert.equal(idx.count(), 0);
});

test("舊 @handle 紀錄在得知 channelId 後自動遷移並合併", () => {
  const idx = ViewerNotesModel.createIndex();

  idx.patch({ handle: "@Sakura" }, { customNickname: "小櫻", addNote: "舊備註" }, 1000);
  assert.equal(idx.find({ handle: "@sakura" }).key, "@sakura");

  const migrated = idx.patch({ channelId: UC_B, handle: "@sakura" }, { addNote: "新備註" }, 2000);
  assert.equal(migrated.record.key, UC_B);
  assert.deepEqual(migrated.removedKeys, ["@sakura"]);
  assert.equal(migrated.record.customNickname, "小櫻");
  assert.deepEqual(migrated.record.notes, ["舊備註", "新備註"]);
  assert.equal(idx.count(), 1);
});

test("過長暱稱與備註自動截斷，無效識別碼略過", () => {
  const idx = ViewerNotesModel.createIndex();
  assert.equal(idx.patch({ channelId: "bad", handle: "no-at" }, { customNickname: "x" }).record, null);

  const res = idx.patch(
    { channelId: UC_A },
    { customNickname: "名".repeat(80), addNote: "備".repeat(400) },
    1000
  );
  assert.equal(res.record.customNickname.length, ViewerNotesModel.MAX_NICK_LEN);
  assert.equal(res.record.notes[0].length, ViewerNotesModel.MAX_NOTE_LEN);
});

test("匯入備份：只合併不刪除，較新的本機暱稱不會被舊備份覆蓋", () => {
  const M = ViewerNotesModel;
  const local = { key: UC_A, channelId: UC_A, customNickname: "新暱稱", notes: ["本機備註"], updatedAt: 5000 };

  // 舊備份：暱稱不覆蓋，備註合併
  const older = M.mergeImportPatch(local, { channelId: UC_A, customNickname: "舊暱稱", notes: ["備份備註"], updatedAt: 1000 });
  assert.equal("customNickname" in older.patch, false);
  assert.deepEqual(older.patch.notes, ["本機備註", "備份備註"]);
  assert.equal(older.updatedAt, 5000);

  // 較新的備份：暱稱以備份為準
  const newer = M.mergeImportPatch(local, { channelId: UC_A, customNickname: "更新", notes: [], updatedAt: 9000 });
  assert.equal(newer.patch.customNickname, "更新");
  assert.deepEqual(newer.patch.notes, ["本機備註"]);

  // 空紀錄不會清掉本機資料
  assert.equal(M.mergeImportPatch(local, { channelId: UC_A, customNickname: "", notes: [] }), null);

  // 本機沒有的紀錄直接新增
  const fresh = M.mergeImportPatch(null, { channelId: UC_B, customNickname: "B", updatedAt: 0 });
  assert.equal(fresh.patch.customNickname, "B");
  assert.ok(fresh.updatedAt > 0);
});
