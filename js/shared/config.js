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

  // 語言設定鍵值
  LANG_KEY: "yt_realname_lang",

  // 拆分為兩個獨立的保險絲 Key，避免狀態寫入時發生 Race Condition
  // 儲存格式: { status: 'NORMAL' | 'TRIPPED', reason: string, timestamp: number }
  FUSE_FE_KEY: "yt_realname_fuse_frontend", // 前端保險絲 (控制 Scanner)
  FUSE_BE_KEY: "yt_realname_fuse_backend",  // 後端保險絲 (控制 Fetcher)

  // === 預設參數設定 ===
  // 名稱顯示的最大長度
  DEFAULT_MAX_LENGTH: 20,
  // 預設資料過期天數
  DEFAULT_TTL_DAYS: 15,
  // 預設資料刪除天數
  DEFAULT_DELETE_DAYS: 30,
  // 預設 Log 開關
  DEFAULT_DEBUG_MODE: false,
  // 預設語言
  DEFAULT_LANG: "en",

  // 除錯模式開關
  // true: 開啟詳細日誌 (Console Log)，便於開發除錯。
  // false: 關閉日誌，適用於正式發布版本，保持 Console 乾淨。
  DEBUG_MODE: false,

  // 保險絲閥值設定
  FUSE_CONFIG: {
    // 後端連續錯誤次數閥值 (超過此數字觸發後端熔斷)
    // 定義：抓不到資料、解析失敗、429 等
    BACKEND_ERROR_THRESHOLD: 10,
    
    // 前端 DOM 操作連續錯誤閥值 (超過此數字觸發前端熔斷)
    // 定義：找不到預期元素導致報錯、插入失敗等
    FRONTEND_ERROR_THRESHOLD: 20,
  },

  // 抓取速度控制 (Rate Limiting)
  // 用途：設定每次爬蟲抓取後的延遲時間範圍（毫秒），以降低被 YouTube 偵測為機器人的風險。
  SPEED_PRESETS: {
    NORMAL: { MIN: 1200, MAX: 2500 }, // 一般模式：隨機延遲 1.2 ~ 2.5 秒
    SLOW: { MIN: 3500, MAX: 6000 }, // 安全模式：隨機延遲 3.5 ~ 6.0 秒 (適用於高風險情境)
  },
};