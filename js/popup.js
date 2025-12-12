// ===========================================================
// Popup.js - 擴充功能彈出視窗邏輯
// 用途：處理 Browser Action Popup 的介面互動、統計數據顯示與簡易設定。
// ===========================================================

const { CACHE_KEY, TTL, SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY, DEFAULT_MAX_LENGTH } = window.AppConfig;
const countEl = document.getElementById("countText");
const openBtn = document.getElementById("openManagerBtn");
const manualBtn = document.getElementById("openManualBtn");
const readmeBtn = document.getElementById("openReadmeBtn");

// UI 元素參考
const maxLengthInput = document.getElementById("maxLengthInput");
const clickToCopyInput = document.getElementById("clickToCopyInput"); 
const fetchSpeedSelect = document.getElementById("fetchSpeedSelect"); 
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

// 更新統計數據
function updateStats() {
  chrome.storage.local.get(CACHE_KEY, (res) => {
    const raw = res[CACHE_KEY] || {};
    const now = Date.now();
    let count = 0;
    for (const [id, data] of Object.entries(raw)) {
      if (data && data.name && (now - (data.ts||0) <= TTL)) {
        count++;
      }
    }
    countEl.textContent = count;
  });
}

// 載入使用者設定
function loadSettings() {
  chrome.storage.local.get([SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY], (res) => {
    const settings = res[SETTINGS_KEY] || {};
    maxLengthInput.value = settings.maxLength || DEFAULT_MAX_LENGTH;
    
    clickToCopyInput.checked = res[CLICK_TO_COPY_KEY] === true;
    
    // 預設速度模式為 NORMAL
    fetchSpeedSelect.value = res[FETCH_SPEED_KEY] || "NORMAL";
  });
}

// 儲存設定事件
saveSettingsBtn.addEventListener("click", () => {
  const val = parseInt(maxLengthInput.value, 10);
  const isClickToCopy = clickToCopyInput.checked;
  const speedMode = fetchSpeedSelect.value;
  
  // 驗證輸入值
  if (isNaN(val) || val < 5 || val > 50) {
    alert("請輸入 5 到 50 之間的數字");
    return;
  }

  // 寫入 Storage
  // 讀取目前的設定
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    const currentSettings = res[SETTINGS_KEY] || {};

    // 合併設定 
    const newSettings = {
        ...currentSettings,
        maxLength: val
    };

    // 寫回完整的設定物件
    chrome.storage.local.set({ 
        [SETTINGS_KEY]: newSettings,
        [CLICK_TO_COPY_KEY]: isClickToCopy,
        [FETCH_SPEED_KEY]: speedMode
    }, () => {
      // 按鈕狀態回饋 
      const originalText = saveSettingsBtn.textContent;
      saveSettingsBtn.textContent = "已儲存！";
      saveSettingsBtn.style.background = "#2e7d32";
      
      setTimeout(() => {
        saveSettingsBtn.textContent = originalText;
        saveSettingsBtn.style.background = "";
      }, 1500);
    });
  });
});

// 開啟管理頁面
openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "manager.html" });
});

// 開啟說明書頁面
if (manualBtn) {
  manualBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "manual.html" });
  });
}

if (readmeBtn) {
  readmeBtn.addEventListener("click", () => {
    // 開啟README.txt
    chrome.tabs.create({ url: "README.txt" });
  });
}

// 動態載入版本號
const manifestData = chrome.runtime.getManifest();
const versionSpan = document.getElementById("appVersion");
if (versionSpan) {
    versionSpan.textContent = "v" + manifestData.version;
}

// 初始化執行
updateStats();
loadSettings();