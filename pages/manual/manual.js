document.addEventListener("DOMContentLoaded", async () => {
  // === 初始化 I18n ===
  await I18n.init();
  I18n.render();

  // === 顯示版本號 ===
  const manifestData = chrome.runtime.getManifest();
  const versionEl = document.getElementById("manualVersion");
  if (versionEl) {
    versionEl.textContent = "v" + manifestData.version;
  }

  // 更新標題以符合語言
  document.title = I18n.t("manual") + " - " + I18n.t("app_title");
});