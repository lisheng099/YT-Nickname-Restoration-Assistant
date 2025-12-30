document.addEventListener("DOMContentLoaded", async () => {
  await I18n.init();
  I18n.render();

  const btn = document.getElementById("testBtn");
  const input = document.getElementById("handleInput");
  const els = {
    status: document.getElementById("resStatus"),
    name: document.getElementById("resName"),
    subs: document.getElementById("resSubs"),
    raw: document.getElementById("resRaw"),
  };

  if (!btn || !input) return; // 簡單防呆

  btn.addEventListener("click", () => {
    const handle = input.value.trim();
    if (!handle) return alert(I18n.t("alert_input_handle"));

    // UI 重置
    btn.disabled = true;
    btn.textContent = I18n.t("fetching"); 
    els.status.textContent = I18n.t("sending"); 
    els.status.className = "value";
    els.name.textContent = "-";
    els.subs.textContent = "-";
    els.raw.textContent = "";

    const startTime = Date.now();

    // 發送訊息給 Background.js
    chrome.runtime.sendMessage(
      {
        type: "FETCH_CHANNEL_INFO",
        handle: handle,
        refresh: true,
      },
      (response) => {
        const duration = Date.now() - startTime;
        btn.disabled = false;
        btn.textContent = I18n.t("btn_force_fetch"); 

        console.log("[Test Result]", response);
        els.raw.textContent = JSON.stringify(response, null, 2);

        if (!response) {
          els.status.innerHTML = `<span class="status-err">無回應 (Runtime Error)</span>`;
          return;
        }

        if (response.success) {
          els.status.innerHTML = `<span class="status-ok">${I18n.t("status_ok")} (${duration}ms)</span>`;
          els.name.textContent = response.nameRaw;
          els.subs.textContent = response.subs + " (Raw)";
        } else {
          els.status.innerHTML = `<span class="status-err">${I18n.t("status_fail")}: ${
            response.error || "Unknown"
          }</span>`;
          if (response.status === 429) {
            els.status.innerHTML += " " + I18n.t("status_rate_limit");
          }
        }
      }
    );
  });
});