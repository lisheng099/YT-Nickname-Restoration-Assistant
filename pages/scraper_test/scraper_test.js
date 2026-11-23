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

  if (!btn || !input) return;

  function setStatus(className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    els.status.replaceChildren(span);
  }

  btn.addEventListener("click", () => {
    const handle = input.value.trim();
    if (!handle) return alert(I18n.t("alert_input_handle"));

    btn.disabled = true;
    btn.textContent = I18n.t("fetching");
    els.status.textContent = I18n.t("sending");
    els.status.className = "value";
    els.name.textContent = "-";
    els.subs.textContent = "-";
    els.raw.textContent = "";

    const startTime = Date.now();

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

        els.raw.textContent = JSON.stringify(response, null, 2);

        if (!response) {
          setStatus("status-err", "無回應 (Runtime Error)");
          return;
        }

        if (response.success) {
          setStatus("status-ok", `${I18n.t("status_ok")} (${duration}ms)`);
          els.name.textContent = response.nameRaw;
          els.subs.textContent = `${response.subs} (Raw)`;
        } else {
          let errMsg = `${I18n.t("status_fail")}: ${response.error || "Unknown"}`;
          if (response.status === 429) {
            errMsg += ` ${I18n.t("status_rate_limit")}`;
          }
          setStatus("status-err", errMsg);
        }
      }
    );
  });
});
