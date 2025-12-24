// ===========================================================
// Config.js - 全域設定檔
// 用途：集中管理應用程式的所有參數設定，方便後續維護與調整。
// ===========================================================

const globalScope = typeof window !== "undefined" ? window : self;

globalScope.AppConfig = {
  // 快取儲存鍵值 (Storage Key)
  // 注意：此為存取瀏覽器本地資料庫的唯一識別碼，若修改將導致無法讀取舊使用者的歷史資料。
  CACHE_KEY: "yt_realname_store",

  // 使用者偏好設定的儲存鍵值
  SETTINGS_KEY: "yt_realname_settings",

  // 「點擊複製」功能的開關狀態鍵值
  CLICK_TO_COPY_KEY: "yt_realname_click_copy",

  // 「抓取速度」模式的儲存鍵值 (NORMAL / SLOW)
  FETCH_SPEED_KEY: "yt_realname_fetch_speed",

  // === 預設參數設定 ===
  // 名稱顯示的最大長度
  DEFAULT_MAX_LENGTH: 20,
  // 預設資料過期天數
  DEFAULT_TTL_DAYS: 15,
  // 預設資料刪除天數
  DEFAULT_DELETE_DAYS: 30,
  // 預設 Log 開關
  DEFAULT_DEBUG_MODE: false,

  // TTL (Time To Live)：快取資料的有效期限
  // 計算方式：7天 * 24小時 * 60分 * 60秒 * 1000毫秒
  // 說明：設定過短會導致請求頻繁可能被封鎖；設定過長則會導致資料更新不及時。目前設定為 7 天。
  TTL: 7 * 24 * 60 * 60 * 1000,

  // 除錯模式開關
  // true: 開啟詳細日誌 (Console Log)，便於開發除錯。
  // false: 關閉日誌，適用於正式發布版本，保持 Console 乾淨。
  DEBUG_MODE: false,

  // 抓取速度控制 (Rate Limiting)
  // 用途：設定每次爬蟲抓取後的延遲時間範圍（毫秒），以降低被 YouTube 偵測為機器人的風險。
  SPEED_PRESETS: {
    NORMAL: { MIN: 1200, MAX: 2500 }, // 一般模式：隨機延遲 1.2 ~ 2.5 秒
    SLOW: { MIN: 3500, MAX: 6000 }, // 安全模式：隨機延遲 3.5 ~ 6.0 秒 (適用於高風險情境)
  },
};
