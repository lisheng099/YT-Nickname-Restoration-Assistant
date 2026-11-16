// 打包可上架的 zip：只包含擴充功能執行時需要的檔案。
// 用法：npm run package  ->  dist/yt-nickname-assistant-<version>.zip
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHIPPED = ["manifest.json", "README.txt", "_locales", "icons", "js", "pages"];

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const out = path.join(ROOT, "dist", `yt-nickname-assistant-${version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync("zip", ["-r", "-q", "-X", out, ...SHIPPED], { cwd: ROOT, stdio: "inherit" });
console.log(out);

module.exports = { SHIPPED };
