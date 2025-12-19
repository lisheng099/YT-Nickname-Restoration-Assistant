// ===========================================================
// background.js - 背景服務入口
// ===========================================================

// 引入設定檔與快取管理器
try {
    importScripts('config.js', 'bg_cache.js');
} catch (e) {
    console.error(e);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_CHANNEL_INFO") {
    fetchChannelInfo(request.handle).then(sendResponse);
    return true; // 保持通道開啟以進行非同步回應
  }
});

async function fetchChannelInfo(handle) {

  // 即使前端因為競態條件誤判沒資料而發送了請求，後端在這裡做最後確認。
  // 如果快取中有有效的資料，直接回傳，防止多餘的爬蟲請求。
  const cachedData = BgCache.get(handle);
  if (handle === null || handle === undefined) {
      return { success: true, nameRaw: handle, subs:0 };
  }

  let controller = null;
  let timeoutId = null;

  try {
    const cleanHandle = handle.replace(/^@/, '');
    const targetUrl = `https://www.youtube.com/@${encodeURIComponent(cleanHandle)}`;

    // 設定逾時控制 (25秒)
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 25000);

    // 發起請求
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
      credentials: "include", 
      headers: {
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36"
      }
    });

    // 檢查是否被導向登入頁面 (Soft Ban 檢測)
    if (response.url.includes("google.com/accounts") || response.url.includes("consent.youtube.com")) {
        clearTimeout(timeoutId);
        return { error: "Redirected to login/consent", status: 429 };
    }

    if (response.status === 429) {
      clearTimeout(timeoutId);
      return { error: "Too Many Requests", status: 429 };
    }


    let resultName = null;
    let resultSubs = null;

    const text = await response.text();
    console.log("text length:", text.length); 
    const jsonMatch = text.match(/ytInitialData\s*=\s*({.+?});/);

    if (!jsonMatch) {
         return { error: "Parse error: ytInitialData not found" };
    }

    let jsonData= JSON.parse(jsonMatch[1]);

    let name = null;
    let subs = null;

    const pageHeader = jsonData.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
    if (pageHeader) {
      
      // 抓名稱
      name = pageHeader.title?.dynamicTextViewModel?.text?.content;

      // 抓訂閱數 
      const rows = pageHeader.metadata?.contentMetadataViewModel?.metadataRows;
      if (rows && rows.length > 1) {
        // 根據 JSON，訂閱數在第二個 row (index 1) 的第一個 part
        const parts = rows[1].metadataParts;
        if (parts && parts.length > 0) {
          subs = parts[0].text?.content;
        }
      } else if (rows && rows.length > 0) {
        // 備用：有時候只有一行，嘗試在第一行找找看
        const parts = rows[0].metadataParts;
        if (parts) {
          // 遍歷所有 part 找看起來像訂閱數的
          const subPart = parts.find(p => p.text?.content && (p.text.content.includes("訂閱") || p.text.content.includes("subscribers")));
          if (subPart) subs = subPart.text.content;
        }
      }
    }
    resultName = name;
    resultSubs = subs;
    clearTimeout(timeoutId);

    if (resultName) {
      let numericSubs = resultSubs ? parseSubsString(resultSubs) : 0;
      if (numericSubs<500) numericSubs=0; //過濾500以下訂閱數
      return { success: true, nameRaw: resultName, subs: numericSubs };
    } else {
      return { error: "Name not found" };
    }

  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    if (err.name === 'AbortError' || err.message.includes('The user aborted a request')) {
        return { error: "Aborted" };
    }
    return { error: err.message };
  }
}

// 輔助函式
function parseSubsString(str) {
    if (!str) return 0;
    let val = parseFloat(str.replace(/[^0-9.]/g, ''));
    if (isNaN(val)) return 0;
    
    const upper = str.toUpperCase();
    if (upper.includes('K')) val *= 1000;
    else if (upper.includes('M')) val *= 1000000;
    else if (upper.includes('B')) val *= 1000000000;
    else if (upper.includes('萬')) val *= 10000;
    else if (upper.includes('億')) val *= 100000000;
    
    return Math.floor(val);
}