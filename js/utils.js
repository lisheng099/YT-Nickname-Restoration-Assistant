// ===========================================================
// Utils.js - 通用工具函式庫
// 用途：封裝應用程式共用的基礎功能，如日誌記錄與字串處理。
// ===========================================================

// 確保全域設定已載入，若遺失則提供預設值以防止 Runtime Error
const _Config = window.AppConfig || { DEBUG_MODE: true };

// === Logger 日誌封裝 ===
const Logger = {
  _log: (color, ...args) => {
    if (!_Config.DEBUG_MODE) return;
    const time = new Date().toLocaleTimeString();
    console.log(`%c[RealName ${time}]`, `color:${color};font-weight:bold;`, ...args);
  },
  
  green: (...args) => Logger._log("#4CAF50", ...args),  // 成功/正常狀態
  red: (...args) => Logger._log("#F44336", ...args),    // 錯誤/異常狀態
  orange: (...args) => Logger._log("#FF9800", ...args), // 警告/注意狀態
  info: (...args) => Logger._log("#2196F3", ...args),   // 一般資訊
};

const _parser = new DOMParser();

// === HTML 實體解碼 ===
function decodeHtmlEntities(str) {
  if (!str) return "";
  try {
    const doc = _parser.parseFromString(str, 'text/html');
    return doc.documentElement.textContent || str;
  } catch (e) {
    return str;
  }
}

// === 正規表達式跳脫 ===
// 用途：將字串中的特殊符號 (如 ., *, ?) 加上反斜線，確保放入 RegExp 時被視為普通文字。
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}