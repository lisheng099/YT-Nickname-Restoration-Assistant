// ===========================================================
// Popup.js - 擴充功能彈出視窗邏輯 (100% 本機運作)
// ===========================================================

const {
  SETTINGS_KEY,
  CLICK_TO_COPY_KEY,
  LOCAL_NOTES_KEY,
  FETCH_SPEED_KEY,
  DEFAULT_MAX_LENGTH,
  DEFAULT_TTL_DAYS,
  DEFAULT_DELETE_DAYS,
  DEFAULT_DEBUG_MODE,
  LANG_KEY,
  FUSE_FE_KEY,
  FUSE_BE_KEY,
} = window.AppConfig;

const countEl = document.getElementById("countText");
const notesCountEl = document.getElementById("notesCountText");
const openBtn = document.getElementById("openManagerBtn");
const manualBtn = document.getElementById("openManualBtn");
const readmeBtn = document.getElementById("openReadmeBtn");

const maxLengthInput = document.getElementById("maxLengthInput");
const clickToCopyInput = document.getElementById("clickToCopyInput");
const localNotesInput = document.getElementById("localNotesInput");
const dualNodeInput = document.getElementById("dualNodeInput");
const fetchSpeedSelect = document.getElementById("fetchSpeedSelect");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const ttlDaysInput = document.getElementById("ttlDaysInput");
const deleteDaysInput = document.getElementById("deleteDaysInput");
const debugModeInput = document.getElementById("debugModeInput");
const langSelect = document.getElementById("langSelect");
const themeSelect = document.getElementById("themeSelect");

const fuseContainer = document.getElementById("fuseContainer");
const fuseFeCapsule = document.getElementById("fuseFrontendCapsule");
const fuseBeCapsule = document.getElementById("fuseBackendCapsule");

let stateFE = { status: "NORMAL", reason: null };
let stateBE = { status: "NORMAL", reason: null };
let isDebugModeEnabled = false;

if (langSelect) {
  langSelect.addEventListener("change", (e) => {
    const newLang = e.target.value;
    chrome.storage.local.set({ [LANG_KEY]: newLang }, async () => {
      await I18n.init();
      I18n.render();
      updateFuseUI();
    });
  });
}

if (themeSelect && window.ThemeManager) {
  themeSelect.addEventListener("change", (e) => {
    window.ThemeManager.setMode(e.target.value);
  });
}

function updateStats() {
  countEl.textContent = "...";
  chrome.runtime.sendMessage({ type: "GET_CACHE_COUNT" }, (response) => {
    if (chrome.runtime.lastError) {
      countEl.textContent = "Err";
      return;
    }
    countEl.textContent = response && typeof response.count === "number" ? response.count : "0";
  });

  if (notesCountEl) {
    notesCountEl.textContent = "...";
    chrome.runtime.sendMessage({ type: "NOTES_COUNT" }, (response) => {
      if (chrome.runtime.lastError) {
        notesCountEl.textContent = "Err";
        return;
      }
      notesCountEl.textContent =
        response && typeof response.count === "number" ? response.count : "0";
    });
  }
}

function loadSettings() {
  chrome.storage.local.get(
    [SETTINGS_KEY, CLICK_TO_COPY_KEY, LOCAL_NOTES_KEY, FETCH_SPEED_KEY, FUSE_FE_KEY, FUSE_BE_KEY],
    (res) => {
      const settings = res[SETTINGS_KEY] || {};

      maxLengthInput.value = settings.maxLength || DEFAULT_MAX_LENGTH;
      ttlDaysInput.value = settings.ttlDays || DEFAULT_TTL_DAYS;
      deleteDaysInput.value = settings.deleteDays || DEFAULT_DELETE_DAYS;
      if (dualNodeInput) dualNodeInput.checked = settings.dualNode !== false;

      if (settings.debugMode !== undefined) {
        debugModeInput.checked = settings.debugMode;
        isDebugModeEnabled = settings.debugMode;
      } else {
        debugModeInput.checked = DEFAULT_DEBUG_MODE;
        isDebugModeEnabled = DEFAULT_DEBUG_MODE;
      }

      clickToCopyInput.checked = res[CLICK_TO_COPY_KEY] === true;
      if (localNotesInput) localNotesInput.checked = res[LOCAL_NOTES_KEY] !== false;
      fetchSpeedSelect.value = res[FETCH_SPEED_KEY] || "NORMAL";

      if (res[FUSE_FE_KEY]) stateFE = res[FUSE_FE_KEY];
      if (res[FUSE_BE_KEY]) stateBE = res[FUSE_BE_KEY];

      updateFuseUI();
    }
  );
}

function updateFuseUI() {
  const feTripped = stateFE.status === "TRIPPED";
  const beTripped = stateBE.status === "TRIPPED";

  if (feTripped || beTripped || isDebugModeEnabled) {
    fuseContainer.classList.add("show");
  } else {
    fuseContainer.classList.remove("show");
  }

  updateCapsule(fuseFeCapsule, feTripped, stateFE.reason, "fe");
  updateCapsule(fuseBeCapsule, beTripped, stateBE.reason, "be");
}

function updateCapsule(element, isTripped, reasonKey, type) {
  const icon = element.querySelector(".fuse-icon");

  if (isTripped) {
    element.classList.remove("normal");
    element.classList.add("tripped");
    icon.textContent = "⚠️";

    let reasonText = "";
    if (reasonKey === "manual") reasonText = I18n.t("fuse_reason_manual");
    else if (reasonKey === "backend") reasonText = I18n.t("fuse_reason_backend");
    else if (reasonKey === "frontend") reasonText = I18n.t("fuse_reason_frontend");
    else reasonText = reasonKey || "Unknown";

    const statusDesc =
      type === "fe" ? I18n.t("fuse_fe_desc_tripped") : I18n.t("fuse_be_desc_tripped");
    element.title = `${reasonText}\n${statusDesc}\n(${I18n.t("fuse_btn_reset")})`;
  } else {
    element.classList.remove("tripped");
    element.classList.add("normal");
    icon.textContent = type === "fe" ? "🖥️" : "⚡";

    const statusDesc = type === "fe" ? I18n.t("fuse_fe_desc_ok") : I18n.t("fuse_be_desc_ok");
    element.title = `${I18n.t("fuse_status_ok")}\n${statusDesc}\n(${I18n.t("fuse_btn_stop")})`;
  }
}

fuseFeCapsule.addEventListener("click", () => {
  if (stateFE.status === "TRIPPED") {
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
  const isLocalNotes = localNotesInput ? localNotesInput.checked : true;
  const isDualNode = dualNodeInput ? dualNodeInput.checked : true;
  const isDebugMode = debugModeInput.checked;
  const speedMode = fetchSpeedSelect.value;

  if (isNaN(maxLength) || maxLength < 5 || maxLength > 50)
    return alert(I18n.t("alert_length_invalid"));
  if (isNaN(ttlDays) || ttlDays < 7 || ttlDays > 365)
    return alert(I18n.t("alert_ttl_invalid"));
  if (isNaN(deleteDays) || deleteDays < ttlDays || deleteDays > 730)
    return alert(I18n.t("alert_del_invalid"));

  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    const currentSettings = res[SETTINGS_KEY] || {};

    const newSettings = {
      ...currentSettings,
      maxLength,
      ttlDays,
      deleteDays,
      dualNode: isDualNode,
      debugMode: isDebugMode,
    };

    chrome.storage.local.set(
      {
        [SETTINGS_KEY]: newSettings,
        [CLICK_TO_COPY_KEY]: isClickToCopy,
        [LOCAL_NOTES_KEY]: isLocalNotes,
        [FETCH_SPEED_KEY]: speedMode,
      },
      () => {
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

openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "pages/manager/manager.html" });
});

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

const manifestData = chrome.runtime.getManifest();
const versionSpan = document.getElementById("appVersion");
if (versionSpan) {
  versionSpan.textContent = "v" + manifestData.version;
}

const twitterBtn = document.getElementById("openTwitterBtn");
if (twitterBtn) {
  twitterBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://x.com/Boo12087" });
  });
}

async function init() {
  await I18n.init();
  I18n.render();
  if (langSelect) langSelect.value = I18n.currentLang;
  if (window.ThemeManager) {
    const mode = await window.ThemeManager.init();
    if (themeSelect) themeSelect.value = mode;
  }
  updateStats();
  loadSettings();
}

init();
