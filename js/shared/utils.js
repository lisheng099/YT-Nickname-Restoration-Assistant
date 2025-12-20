// ===========================================================
// Utils.js - 通用工具函式庫 (通用版)
// 用途：封裝應用程式共用的基礎功能，如日誌記錄與字串處理。
// ===========================================================

// 1. 取得全域物件 (相容 Browser Window 與 Service Worker)
const _global = (typeof window !== "undefined") ? window : self;

// 確保全域設定已載入
const _Config = _global.AppConfig || { DEBUG_MODE: true };

// === Logger 日誌封裝 ===
const Logger = {
  _log: (color, ...args) => {
    // 檢查 DEBUG_MODE
    if (!_Config.DEBUG_MODE) return;
    
    // 加上環境標記 [Content] 或 [Bg]
    const env = (typeof window !== "undefined") ? "Content" : "Bg";
    const time = new Date().toLocaleTimeString();
    
    console.log(`%c[${env} ${time}]`, `color:${color};font-weight:bold;`, ...args);
  },
  
  green: (...args) => Logger._log("#4CAF50", ...args),  // 成功
  red: (...args) => Logger._log("#F44336", ...args),    // 錯誤
  orange: (...args) => Logger._log("#FF9800", ...args), // 警告
  info: (...args) => Logger._log("#2196F3", ...args),   // 資訊
};

// === HTML 解析與編碼工具 ===
// Service Worker 沒有 DOMParser，需要做環境判斷
let decodeHtmlEntities;

if (typeof DOMParser !== "undefined") {
    // [前台模式] 使用瀏覽器原生的 DOMParser
    const _parser = new DOMParser();
    decodeHtmlEntities = function(str) {
      if (!str) return "";
      try {
        const doc = _parser.parseFromString(str, 'text/html');
        return doc.documentElement.textContent || str;
      } catch (e) {
        return str;
      }
    };
} else {
    // [背景模式] 簡單的替代方案 (背景主要只負責抓取和傳遞 raw data)
    // 實際上背景抓取完後，我們通常會丟回前台再做最終呈現，
    // 但如果有必要在背景解碼，可以使用簡易替換表。
    decodeHtmlEntities = function(str) {
        if (!str) return "";
        return str.replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'");
    };
}

// === 正規表達式跳脫 ===
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// === XSS 防護 ===
function escapeHtml(str) {
  if (!str) return "";
  // Service Worker 沒有 document，無法使用 createElement
  if (typeof document === "undefined") {
      return str.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
  }
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}