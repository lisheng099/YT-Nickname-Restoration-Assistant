// 以真正的 Chromium 載入擴充功能，並把 YouTube 聊天室網址導向本機的模擬頁面。
// 模擬頁面只有聊天訊息的基本結構；這些測試驗證擴充功能本身的流程，
// 無法取代在真實 YouTube 頁面上的檢查。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UC = (c) => "UC" + String(c).repeat(22);
const CHAT_URL = "https://www.youtube.com/live_chat?v=abcdefghijk";

async function launch(extensionDir, { onRequest, mockHtml } = {}) {
  const { chromium } = require("playwright");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ext-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const html = mockHtml || fs.readFileSync(path.join(__dirname, "mock_chat.html"), "utf8");
  const requests = [];
  // 所有對外請求都在這裡攔下：模擬頁面由本機提供，其餘一律記錄後中止
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("chrome-extension://")) return route.continue();
    if (url.startsWith("https://www.youtube.com/live_chat")) {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    }
    requests.push(url);
    if (onRequest) {
      const handled = await onRequest(route, url);
      if (handled) return;
    }
    return route.abort();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const close = async () => {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  };
  return { context, worker, extensionId, requests, close };
}

module.exports = { launch, UC, CHAT_URL };
