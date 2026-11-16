// 純本地版的保證：不要求任何外部伺服器權限，程式中也沒有連到 YouTube 以外的管道。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHIPPED_DIRS = ["js", "pages", "_locales"];

function shippedFiles() {
  const out = [path.join(ROOT, "manifest.json")];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|json|css)$/.test(entry.name)) out.push(full);
    }
  };
  SHIPPED_DIRS.forEach((d) => walk(path.join(ROOT, d)));
  return out;
}

test("manifest 只要求 storage 與 YouTube 網域", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions.sort(), ["https://studio.youtube.com/*", "https://www.youtube.com/*"]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  for (const script of manifest.content_scripts) {
    for (const match of script.matches) assert.match(match, /^https:\/\/(www|studio)\.youtube\.com\//);
  }
});

test("manifest 引用的檔案都存在", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const files = [
    manifest.background.service_worker,
    manifest.options_page,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((s) => s.js),
  ];
  for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
});

test("只有抓取器會發出網路請求，且沒有其他連線管道", () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, "utf8");
    if (/\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\(\s*["']https?:)/.test(src)) offenders.push(rel);
    if (/(?<![.\w])fetch\(/.test(src) && rel !== path.join("js", "background", "bg_fetcher.js")) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test("程式中出現的網址只有 YouTube 與專案說明連結", () => {
  const allowed = [
    /^https:\/\/www\.youtube\.com\b/,
    /^https:\/\/studio\.youtube\.com\b/,
    /^https?:\/\/(www\.)?youtube\.com\b/,
    /^https:\/\/github\.com\/(lisheng099|jakearchibald)\//, // 專案與函式庫來源 (註解與說明頁)
    /^https:\/\/x\.com\/Boo12087$/, // 回報問題連結 (由使用者點擊開啟分頁)
    /^http:\/\/www\.w3\.org\//, // SVG 命名空間
  ];
  const offenders = [];
  for (const file of shippedFiles()) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/https?:\/\/[^\s"'`<>)\\]+/g)) {
      const url = m[0].replace(/[.,;]+$/, "");
      if (/^https?:\/\/\(/.test(url) || /^https?:\/\/$/.test(url)) continue; // 正規表示式片段
      if (!allowed.some((re) => re.test(url))) offenders.push(`${path.relative(ROOT, file)}: ${url}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("背景服務載入的模組都在套件內", () => {
  const src = fs.readFileSync(path.join(ROOT, "js/background/background.js"), "utf8");
  const block = src.match(/importScripts\(([\s\S]*?)\);/)[1];
  const files = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 7);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, "js/background", f)), f);
});
