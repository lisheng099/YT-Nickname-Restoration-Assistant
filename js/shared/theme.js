// ===========================================================
// theme.js - 統一外觀主題管理 (跟隨系統 / 淺色 / 暗黑)
// 用途：統一控管所有擴充功能頁面與浮動面板的淺色/暗黑模式，
//       支援自動偵測作業系統主題，切換後即時同步所有已開啟視窗。
// ===========================================================

(function () {
  const globalScope = typeof window !== "undefined" ? window : self;
  const DEFAULT_KEY = "yt_realname_theme";
  const VALID = new Set(["system", "light", "dark"]);

  function getKey() {
    return (globalScope.AppConfig && globalScope.AppConfig.THEME_KEY) || DEFAULT_KEY;
  }

  function resolveTheme(mode) {
    if (mode === "light" || mode === "dark") return mode;
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  }

  const ThemeManager = {
    mode: "system",
    resolved: "light",
    listeners: new Set(),

    apply: function (mode) {
      const normalized = VALID.has(mode) ? mode : "system";
      this.mode = normalized;
      this.resolved = resolveTheme(normalized);
      if (typeof document !== "undefined" && document.documentElement) {
        document.documentElement.dataset.theme = this.resolved;
        document.documentElement.dataset.themeMode = normalized;
        document.documentElement.classList.toggle("dark", this.resolved === "dark");
        if (location.protocol === "chrome-extension:") {
          document.documentElement.style.colorScheme = this.resolved;
        }
      }
      this.listeners.forEach((fn) => {
        try {
          fn(this.resolved, this.mode);
        } catch {
          // ignore
        }
      });
      return this.resolved;
    },

    setMode: function (mode) {
      const normalized = VALID.has(mode) ? mode : "system";
      this.apply(normalized);
      return new Promise((resolve) => {
        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [getKey()]: normalized }, () => resolve(normalized));
            return;
          }
        } catch {
          // ignore
        }
        resolve(normalized);
      });
    },

    onChange: function (fn) {
      if (typeof fn === "function") this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },

    init: function () {
      // Apply system preference immediately to minimize flash before storage loads
      this.apply(this.mode);

      if (!this._bound) {
        this._bound = true;
        try {
          if (window.matchMedia) {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            const onMq = () => {
              if (this.mode === "system") this.apply("system");
            };
            if (mq.addEventListener) mq.addEventListener("change", onMq);
            else if (mq.addListener) mq.addListener(onMq);
          }
        } catch {
          // ignore
        }

        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
              if (area === "local" && changes[getKey()]) {
                this.apply(changes[getKey()].newValue || "system");
              }
            });
          }
        } catch {
          // ignore
        }
      }

      return new Promise((resolve) => {
        try {
          if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(getKey(), (res) => {
              const saved = (res && res[getKey()]) || "system";
              this.apply(saved);
              resolve(this.mode);
            });
            return;
          }
        } catch {
          // ignore
        }
        resolve(this.mode);
      });
    },
  };

  globalScope.ThemeManager = ThemeManager;
  ThemeManager.init();
})();
