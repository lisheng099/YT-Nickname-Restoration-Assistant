// ===========================================================
// I18n.js - 多語言管理系統
// 用途：獨立處理語言切換與文字替換邏輯。
// 說明：此檔案僅包含邏輯，翻譯資料位於 locales.js
// ===========================================================

const I18n = {
  currentLang: "en", // 系統預設值
  
  // 引用外部定義的字典 (Fallback 為空物件避免報錯)
  locales: (typeof I18nLocales !== 'undefined' ? I18nLocales : {}),

  // 初始化方法
  init: async function() {
    return new Promise((resolve) => {
      // 確保 Config 已載入
      const langKey = window.AppConfig?.LANG_KEY || "yt_realname_lang";
      // const defaultLang = window.AppConfig?.DEFAULT_LANG || "zh-TW"; // 移除，改用動態偵測

      chrome.storage.local.get(langKey, (res) => {
        let saved = res[langKey];

        // 核心修改：如果使用者沒有「手動鎖定」過語言 (!saved)，則每次都自動偵測瀏覽器語言
        // 這樣做的好處是：剛安裝時完全全自動，且如果使用者切換 Chrome 語言，外掛也會自動跟隨。
        if (!saved) {
          // 使用 Chrome Extension 專用 API 取得瀏覽器介面語言
          // 回傳範例: "zh-TW", "en-US", "ja", "zh-CN"
          const uiLang = chrome.i18n.getUILanguage(); 
          
          // 轉換邏輯：將瀏覽器語言代碼對應到我們支援的 key
          if (uiLang === "zh-CN" || uiLang === "zh-SG") {
             // 簡體中文 (中國、新加坡)
             this.currentLang = "zh-CN";
          } else if (uiLang.startsWith("zh")) {
             // 其他中文 (台灣、香港、澳門) -> 預設繁中
             this.currentLang = "zh-TW";
          } else if (uiLang.startsWith("ja")) {
             // 日文
             this.currentLang = "ja";
          } else {
             // 其他所有語言 (含 en-US, en-GB, fr, de...) -> 預設英文
             this.currentLang = "en";
          }
        } else {
          // 如果使用者已經手動設定過 (例如他強迫要在中文瀏覽器用英文介面)
          // 則尊重使用者的選擇
          this.currentLang = saved;
        }

        resolve(this.currentLang);
      });
    });
  },

  // 取得翻譯文字
  t: function(key, params = {}) {
    // 取得當前語言字典，若找不到則降級回繁體中文 (Fallback)
    const dict = this.locales[this.currentLang] || this.locales["zh-TW"] || {};
    let str = dict[key];

    // 如果該語言沒有這個 Key，嘗試從預設語言找 (Fallback Key)
    if (str === undefined) {
      if (this.locales["zh-TW"]) {
          str = this.locales["zh-TW"][key];
      }
      // 如果真的都找不到，就回傳 key 本身
      if (str === undefined) str = key;
    }
    
    // 簡單變數替換 {name}
    Object.keys(params).forEach(k => {
      str = str.replace(new RegExp(`{${k}}`, 'g'), params[k]);
    });
    return str;
  },

  // 自動渲染頁面上的 [data-i18n] 元素
  render: function(root = document) {
    // 1. 處理文字內容 textContent
    root.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = this.t(key);
    });

    // 2. 處理屬性 (Tooltip, Placeholder 等)
    // 格式：data-i18n-[attr] = "key"
    const attributes = ["title", "placeholder", "aria-label", "value"];
    attributes.forEach(attr => {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach(el => {
        const key = el.getAttribute(`data-i18n-${attr}`);
        if (key) el.setAttribute(attr, this.t(key));
      });
    });
  }
};