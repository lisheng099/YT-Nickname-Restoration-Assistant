document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('testBtn');
    const input = document.getElementById('handleInput');
    const els = {
      status: document.getElementById('resStatus'),
      name: document.getElementById('resName'),
      subs: document.getElementById('resSubs'),
      raw: document.getElementById('resRaw')
    };
  
    if (!btn || !input) return; // 簡單防呆
  
    btn.addEventListener('click', () => {
      const handle = input.value.trim();
      if (!handle) return alert("請輸入 Handle ID");
  
      // UI 重置
      btn.disabled = true;
      btn.textContent = "抓取中...";
      els.status.textContent = "請求發送中...";
      els.status.className = "value";
      els.name.textContent = "-";
      els.subs.textContent = "-";
      els.raw.textContent = "";
  
      const startTime = Date.now();
  
      // 發送訊息給 Background.js
      chrome.runtime.sendMessage({ type: "FETCH_CHANNEL_INFO", handle: handle }, (response) => {
        const duration = Date.now() - startTime;
        btn.disabled = false;
        btn.textContent = "開始抓取";
  
        console.log("[Test Result]", response);
        els.raw.textContent = JSON.stringify(response, null, 2);
  
        if (!response) {
          els.status.innerHTML = `<span class="status-err">無回應 (Runtime Error)</span>`;
          return;
        }
  
        if (response.success) {
          els.status.innerHTML = `<span class="status-ok">成功 (耗時 ${duration}ms)</span>`;
          els.name.textContent = response.nameRaw;
          els.subs.textContent = response.subs + " (原始數值)";
        } else {
          els.status.innerHTML = `<span class="status-err">失敗: ${response.error || "未知錯誤"}</span>`;
          if (response.status === 429) {
             els.status.innerHTML += " (被 YouTube 限流)";
          }
        }
      });
    });
});