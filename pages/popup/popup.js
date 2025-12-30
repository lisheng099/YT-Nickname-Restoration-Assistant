// ===========================================================
// Popup.js - 擴充功能彈出視窗邏輯
// 用途：處理 Browser Action Popup 的介面互動、統計數據顯示與簡易設定。
// ===========================================================

const {
  CACHE_KEY,
  SETTINGS_KEY,
  CLICK_TO_COPY_KEY,
  FETCH_SPEED_KEY,
  DEFAULT_MAX_LENGTH,
  DEFAULT_TTL_DAYS,
  DEFAULT_DELETE_DAYS,
  DEFAULT_DEBUG_MODE,
  LANG_KEY,
  FUSE_FE_KEY, // 前端保險絲
  FUSE_BE_KEY  // 後端保險絲
} = window.AppConfig;
const countEl = document.getElementById("countText");
const openBtn = document.getElementById("openManagerBtn");
const manualBtn = document.getElementById("openManualBtn");
const readmeBtn = document.getElementById("openReadmeBtn");

// UI 元素參考
const maxLengthInput = document.getElementById("maxLengthInput");
const clickToCopyInput = document.getElementById("clickToCopyInput");
const fetchSpeedSelect = document.getElementById("fetchSpeedSelect");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const ttlDaysInput = document.getElementById("ttlDaysInput");
const deleteDaysInput = document.getElementById("deleteDaysInput");
const debugModeInput = document.getElementById("debugModeInput");
const langSelect = document.getElementById("langSelect"); 

// 膠囊式保險絲 UI 參考
const fuseContainer = document.getElementById("fuseContainer");
const fuseFeCapsule = document.getElementById("fuseFrontendCapsule");
const fuseBeCapsule = document.getElementById("fuseBackendCapsule");

// 狀態暫存
let stateFE = { status: "NORMAL", reason: null };
let stateBE = { status: "NORMAL", reason: null };
let isDebugModeEnabled = false; // 用於控制保險絲面板顯示

if (langSelect) {
  langSelect.addEventListener("change", (e) => {
    const newLang = e.target.value;
    chrome.storage.local.set({ [LANG_KEY]: newLang }, async () => {
      await I18n.init();
      I18n.render();
      updateFuseUI(); // 重繪
    });
  });
}

// === 更新統計數據 (向 Background 詢問) ===
function updateStats() {
  // 顯示讀取中狀態...
  countEl.textContent = "...";

  chrome.runtime.sendMessage({ type: "GET_CACHE_COUNT" }, (response) => {
    // 檢查回傳值
    if (chrome.runtime.lastError) {
      countEl.textContent = "Err";
      return;
    }

    if (response && typeof response.count === "number") {
      countEl.textContent = response.count;
    } else {
      countEl.textContent = "0";
    }
  });
}

// 載入使用者設定
function loadSettings() {
  chrome.storage.local.get(
    [SETTINGS_KEY, CLICK_TO_COPY_KEY, FETCH_SPEED_KEY, FUSE_FE_KEY, FUSE_BE_KEY],
    (res) => {
      const settings = res[SETTINGS_KEY] || {};

      // 讀取或是使用預設值
      maxLengthInput.value = settings.maxLength || DEFAULT_MAX_LENGTH;
      ttlDaysInput.value = settings.ttlDays || DEFAULT_TTL_DAYS;
      deleteDaysInput.value = settings.deleteDays || DEFAULT_DELETE_DAYS;

      // Checkbox 處理 (若沒設定過，使用預設值)
      if (settings.debugMode !== undefined) {
        debugModeInput.checked = settings.debugMode;
        isDebugModeEnabled = settings.debugMode;
      } else {
        debugModeInput.checked = DEFAULT_DEBUG_MODE;
        isDebugModeEnabled = DEFAULT_DEBUG_MODE;
      }

      clickToCopyInput.checked = res[CLICK_TO_COPY_KEY] === true;
      fetchSpeedSelect.value = res[FETCH_SPEED_KEY] || "NORMAL";

      // 載入兩個保險絲狀態
      if (res[FUSE_FE_KEY]) stateFE = res[FUSE_FE_KEY];
      if (res[FUSE_BE_KEY]) stateBE = res[FUSE_BE_KEY];
      
      updateFuseUI();
    }
  );
}

// 更新保險絲 UI (膠囊樣式)
function updateFuseUI() {
  const feTripped = stateFE.status === "TRIPPED";
  const beTripped = stateBE.status === "TRIPPED";

  // 決定是否顯示面板：
  // 1. 任何一個保險絲熔斷 (TRIPPED) -> 顯示
  // 2. 開啟了 Debug Mode -> 顯示 (方便手動測試)
  if (feTripped || beTripped || isDebugModeEnabled) {
    fuseContainer.classList.add("show");
  } else {
    fuseContainer.classList.remove("show");
  }

  // --- 前端保險絲 ---
  updateCapsule(fuseFeCapsule, feTripped, stateFE.reason, "fe");

  // --- 後端保險絲 ---
  updateCapsule(fuseBeCapsule, beTripped, stateBE.reason, "be");
}

function updateCapsule(element, isTripped, reasonKey, type) {
  const icon = element.querySelector(".fuse-icon");
  
  if (isTripped) {
    element.classList.remove("normal");
    element.classList.add("tripped");
    icon.textContent = "⚠️"; // 或 ⛔
    
    // 建立詳細提示文字
    let reasonText = "";
    if (reasonKey === "manual") reasonText = I18n.t("fuse_reason_manual");
    else if (reasonKey === "backend") reasonText = I18n.t("fuse_reason_backend");
    else if (reasonKey === "frontend") reasonText = I18n.t("fuse_reason_frontend");
    else reasonText = reasonKey || "Unknown";

    const statusDesc = type === "fe" ? I18n.t("fuse_fe_desc_tripped") : I18n.t("fuse_be_desc_tripped");
    
    element.title = `${reasonText}\n${statusDesc}\n(${I18n.t("fuse_btn_reset")})`;
  } else {
    element.classList.remove("tripped");
    element.classList.add("normal");
    icon.textContent = type === "fe" ? "🖥️" : "⚡"; // 前端用螢幕，後端用閃電
    
    const statusDesc = type === "fe" ? I18n.t("fuse_fe_desc_ok") : I18n.t("fuse_be_desc_ok");
    element.title = `${I18n.t("fuse_status_ok")}\n${statusDesc}\n(${I18n.t("fuse_btn_stop")})`;
  }
}

// 按鈕事件 - 直接點擊膠囊切換
fuseFeCapsule.addEventListener("click", () => {
  if (stateFE.status === "TRIPPED") {
    // 只有從熔斷 (TRIPPED) 轉為 正常 (NORMAL) 時才提示
    if (confirm(I18n.t("fuse_tripped_hint"))) {
      stateFE = { status: "NORMAL", reason: null, timestamp: Date.now() };
      chrome.storage.local.set({ [FUSE_FE_KEY]: stateFE }, updateFuseUI);
    }
  } else {
    stateFE = { status: "TRIPPED", reason: "manual", timestamp: Date.now() };
    chrome.storage.local.set({ [FUSE_FE_KEY]: stateFE }, updateFuseUI);
  }
});

fuseBeCapsule.addEventListener("click", () => {
  if (stateBE.status === "TRIPPED") {
    // 只有從熔斷 (TRIPPED) 轉為 正常 (NORMAL) 時才提示
    if (confirm(I18n.t("fuse_tripped_hint"))) {
      stateBE = { status: "NORMAL", reason: null, timestamp: Date.now() };
      chrome.storage.local.set({ [FUSE_BE_KEY]: stateBE }, updateFuseUI);
    }
  } else {
    stateBE = { status: "TRIPPED", reason: "manual", timestamp: Date.now() };
    chrome.storage.local.set({ [FUSE_BE_KEY]: stateBE }, updateFuseUI);
  }
});


saveSettingsBtn.addEventListener("click", () => {
  const maxLength = parseInt(maxLengthInput.value, 10);
  const ttlDays = parseInt(ttlDaysInput.value, 10);
  const deleteDays = parseInt(deleteDaysInput.value, 10);

  const isClickToCopy = clickToCopyInput.checked;
  const isDebugMode = debugModeInput.checked;
  const speedMode = fetchSpeedSelect.value;

  // 驗證
  if (isNaN(maxLength) || maxLength < 5 || maxLength > 50)
    return alert(I18n.t("alert_length_invalid")); 
  if (isNaN(ttlDays) || ttlDays < 7 || ttlDays > 365) 
      return alert(I18n.t("alert_ttl_invalid"));
  if (isNaN(deleteDays) || deleteDays < ttlDays || deleteDays > 730)
    return alert(I18n.t("alert_del_invalid"));

  // 寫入 Storage (設定依然存在 storage.local，這是正確的)
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    const currentSettings = res[SETTINGS_KEY] || {};

    const newSettings = {
      ...currentSettings,
      maxLength: maxLength,
      ttlDays: ttlDays,
      deleteDays: deleteDays,
      debugMode: isDebugMode,
    };

    chrome.storage.local.set(
      {
        [SETTINGS_KEY]: newSettings,
        [CLICK_TO_COPY_KEY]: isClickToCopy,
        [FETCH_SPEED_KEY]: speedMode,
      },
      () => {
        // 更新本地狀態並重繪 UI (立刻反映面板顯示/隱藏)
        isDebugModeEnabled = isDebugMode;
        updateFuseUI();

        const originalText = saveSettingsBtn.textContent;
        saveSettingsBtn.textContent = I18n.t("saved");
        saveSettingsBtn.style.background = "#2e7d32";

        setTimeout(() => {
          saveSettingsBtn.textContent = originalText;
          saveSettingsBtn.style.background = "";
        }, 1500);
      }
    );
  });
});

// 開啟管理頁面
openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "pages/manager/manager.html" });
});

// 開啟說明書頁面
if (manualBtn) {
  manualBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "pages/manual/manual.html" });
  });
}

if (readmeBtn) {
  readmeBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "README.txt" });
  });
}

// 動態載入版本號
const manifestData = chrome.runtime.getManifest();
const versionSpan = document.getElementById("appVersion");
if (versionSpan) {
  versionSpan.textContent = "v" + manifestData.version;
}

// X 回報按鈕事件
const twitterBtn = document.getElementById("openTwitterBtn");
if (twitterBtn) {
  twitterBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://x.com/Boo12087" });
  });
}

// 初始化流程
async function init() {
  await I18n.init();
  I18n.render();
  if (langSelect) langSelect.value = I18n.currentLang;
  updateStats();
  loadSettings();
}

init();