// ===========================================================
// i18n.js - 多語言管理系統
// 用途：支援使用者手動切換語言 (zh-TW / zh-CN / en / ja) 與自動偵測瀏覽器語系，
//       並相容 render() 與 apply() 兩種介面渲染呼叫方式。
// ===========================================================

const I18n = {
  currentLang: "en",
  locales: typeof I18nLocales !== "undefined" ? I18nLocales : {},

  init: async function () {
    return new Promise((resolve) => {
      const langKey = (typeof window !== "undefined" && window.AppConfig?.LANG_KEY) || "yt_realname_lang";

      try {
        chrome.storage.local.get(langKey, (res) => {
          const saved = res && res[langKey];
          if (!saved) {
            let uiLang = "en";
            try {
              uiLang = chrome.i18n.getUILanguage() || "en";
            } catch {
              uiLang = "en";
            }
            if (uiLang === "zh-CN" || uiLang === "zh-SG") {
              this.currentLang = "zh-CN";
            } else if (uiLang.startsWith("zh")) {
              this.currentLang = "zh-TW";
            } else if (uiLang.startsWith("ja")) {
              this.currentLang = "ja";
            } else {
              this.currentLang = "en";
            }
          } else {
            this.currentLang = saved;
          }
          resolve(this.currentLang);
        });
      } catch {
        resolve(this.currentLang);
      }
    });
  },

  t: function (key, params = {}) {
    const dict = this.locales[this.currentLang] || this.locales["zh-TW"] || {};
    let str = dict[key];

    if (str === undefined && this.locales["zh-TW"]) {
      str = this.locales["zh-TW"][key];
    }
    if (str === undefined) {
      try {
        str = chrome.i18n.getMessage(key) || undefined;
      } catch {
        str = undefined;
      }
    }
    if (str === undefined) str = key;

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.split(`{${k}}`).join(String(v));
      }
    }
    return str;
  },

  render: function (root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (key) el.textContent = this.t(key);
    });

    const attributes = ["title", "placeholder", "aria-label", "value"];
    attributes.forEach((attr) => {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        const key = el.getAttribute(`data-i18n-${attr}`);
        if (key) el.setAttribute(attr, this.t(key));
      });
    });
  },

  apply: function (root = document) {
    this.render(root);
  },
};
