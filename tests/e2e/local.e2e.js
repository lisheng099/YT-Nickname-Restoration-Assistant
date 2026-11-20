const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launch, UC, CHAT_URL } = require("./harness.js");

const EXT = process.env.EXT_DIR || path.resolve(__dirname, "../..");

test("純本地版：聊天室貼標籤、評分、備註、自訂暱稱，管理頁與匯出", async (t) => {
  const env = await launch(EXT);
  t.after(env.close);
  const page = await env.context.newPage();
  await page.goto(CHAT_URL);
  await page.evaluate((cid) => {
    window.addChat("m1", "@ming", cid, "大家好");
    window.addChat("m2", "@other", "UC" + "z".repeat(22), "安安");
  }, UC("a"));

  // 探針把頻道 ID 寫到屬性上
  await page.waitForSelector(`#m1[data-rn-cid="${UC("a")}"]`);
  // 點頭像開啟編輯面板；有頭像時名稱旁不再放 ✎ 按鈕
  const avatar = page.locator("#m1 #author-photo");
  await page.waitForSelector("#m1 #author-photo[data-rn-vn-avatar]");
  assert.equal(await page.locator("#m1 .rn-vn-edit").count(), 0);
  await page.locator("#m1").hover();
  await avatar.click();
  const panel = page.locator("#rn-vn-panel");
  await panel.waitFor();
  assert.match(await panel.locator(".rn-vn-sub").textContent(), /@ming · UCa+/);
  // YouTube 頭像原本的點擊處理不會被觸發
  assert.equal(await page.evaluate(() => window.nativeAvatarClicks || 0), 0);

  // 自訂暱稱
  await panel.locator('[data-rn-vn-field="nick"]').fill("小明");
  await panel.locator('[data-rn-vn-field="nick"]').press("Enter");
  await page.waitForSelector("#m1 .rn-vn-name");
  assert.equal(await page.locator("#m1 .rn-vn-name").textContent(), "小明");
  assert.equal(await page.locator("#m1 #author-name").isVisible(), false);

  // 新增標籤並貼上
  await panel.locator('[data-rn-vn-field="newtag"]').fill("常客");
  await panel.locator('[data-rn-vn-field="newtag"]').press("Enter");
  await page.waitForSelector("#m1 .rn-vn-chip:not(.rn-vn-score):not(.rn-vn-notechip)");
  assert.equal(await page.locator("#m1 .rn-vn-chip").first().textContent(), "常客");

  // 評分 +1 兩次
  await panel.getByRole("button", { name: "+1" }).click();
  await page.waitForSelector("#m1 .rn-vn-score");
  await panel.getByRole("button", { name: "+1" }).click();
  await page.waitForFunction(() => document.querySelector("#m1 .rn-vn-score")?.textContent === "+2");

  // 備註
  await panel.locator('[data-rn-vn-field="note"]').fill("喜歡貓");
  await panel.locator('[data-rn-vn-field="note"]').press("Enter");
  await page.waitForSelector("#m1 .rn-vn-notechip");
  assert.equal(await page.locator("#m1 .rn-vn-notechip").getAttribute("title"), "喜歡貓");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });

  // 迷你面板：最近發言的筆記與評分榜
  await page.locator("#rn-vn-dock .rn-vn-dock-toggle").click();
  await page.waitForSelector("#rn-vn-dock .rn-vn-dock-item");
  const recent = await page.locator("#rn-vn-dock .rn-vn-dock-body").textContent();
  assert.match(recent, /小明/);
  assert.match(recent, /📌 喜歡貓/);
  await page.locator("#rn-vn-dock [role=tab]").nth(1).click();
  await page.waitForFunction(() => /1\. 小明/.test(document.querySelector("#rn-vn-dock .rn-vn-dock-body")?.textContent || ""));
  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, "local-dock.png") });
  await page.locator("#rn-vn-dock [role=tab]").nth(0).click();

  // 鍵盤也能從頭像開啟另一位觀眾的面板
  await page.locator("#m2 #author-photo").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /@other/.test(document.querySelector("#rn-vn-panel .rn-vn-sub")?.textContent || ""));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#rn-vn-panel"));

  // 找不到頭像的訊息退回在名稱旁放 ✎ 按鈕
  await page.evaluate(() => window.addChat("m5", "@nophoto", "UC" + "x".repeat(22), "沒有頭像", null, true));
  const fallback = page.locator("#m5 .rn-vn-edit");
  await fallback.waitFor({ state: "attached" });
  await page.locator("#m5").hover();
  await fallback.click();
  await page.waitForFunction(() => /@nophoto/.test(document.querySelector("#rn-vn-panel .rn-vn-sub")?.textContent || ""));
  await page.keyboard.press("Escape");

  // 另一位觀眾不受影響
  assert.equal(await page.locator("#m2 .rn-vn-chip").count(), 0);
  assert.equal(await page.locator("#m2 #author-name").isVisible(), true);

  // 同一位觀眾的新訊息直接帶出筆記
  await page.evaluate((cid) => window.addChat("m3", "@ming", cid, "第二則"), UC("a"));
  await page.waitForSelector("#m3 .rn-vn-name");
  assert.equal(await page.locator("#m3 .rn-vn-score").textContent(), "+2");

  // 元素被重複使用給另一位觀眾時，上一位的內容會清掉
  await page.evaluate(() => window.reuseChat("m3", "m4", "@stranger", "UC" + "y".repeat(22), "路過"));
  await page.waitForFunction(() => !document.querySelector("#m4 .rn-vn-name"));
  assert.equal(await page.locator("#m4 .rn-vn-chip").count(), 0);
  assert.equal(await page.locator("#m4 #author-name").isVisible(), true);

  if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, "local-chat.png") });

  // 管理頁
  const manager = await env.context.newPage();
  await manager.goto(`chrome-extension://${env.extensionId}/pages/viewers/viewers.html`);
  await manager.waitForSelector("#rows tr");
  assert.equal(await manager.locator("#rows tr").count(), 1);
  const row = await manager.locator("#rows tr").first().textContent();
  assert.match(row, /小明/);
  assert.match(row, /常客/);
  assert.match(row, /\+2/);
  assert.match(row, /喜歡貓/);

  // 在管理頁改評分，聊天室即時更新
  await manager.locator("#rows tr button").first().click();
  await manager.locator("#edScore").fill("-3");
  await manager.locator("#editorForm button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector("#m1 .rn-vn-score")?.textContent === "-3");

  // 匯出 JSON
  const [download] = await Promise.all([manager.waitForEvent("download"), manager.locator("#exportBtn").click()]);
  const exported = JSON.parse(require("node:fs").readFileSync(await download.path(), "utf8"));
  assert.equal(exported.format, "yt-viewer-notes-v1");
  assert.equal(exported.viewers[0].channelId, UC("a"));
  assert.equal(exported.viewers[0].customNickname, "小明");
  assert.equal(exported.viewers[0].score, -3);

  // 清除後以匯入還原
  manager.on("dialog", (d) => d.accept());
  await manager.locator("#clearBtn").click();
  await manager.waitForFunction(() => document.querySelectorAll("#rows tr").length === 0);
  await page.waitForFunction(() => !document.querySelector("#m1 .rn-vn-name"));
  await manager.locator("#importFile").setInputFiles(await download.path());
  await manager.waitForSelector("#rows tr");
  await page.waitForSelector("#m1 .rn-vn-name");
  if (process.env.SHOT_DIR) await manager.screenshot({ path: path.join(process.env.SHOT_DIR, "local-manager.png") });

  // 零雲端連線：整個流程中，除了 YouTube 本身之外沒有任何對外請求
  const external = env.requests.filter((u) => !/^https:\/\/www\.youtube\.com\//.test(u));
  assert.deepEqual(external, []);
});
