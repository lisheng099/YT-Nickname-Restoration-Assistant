// ===========================================================
// background.js - 背景網路請求管理器
// 用途：從背景呼叫爬蟲取得資料，處理跨網域請求與串流解析。
// ===========================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "FETCH_CHANNEL_INFO") {
    fetchChannelInfo(request.handle).then(sendResponse);
    return true; // 保持通道開啟以進行非同步回應
  }
});

async function fetchChannelInfo(handle) {
  let controller = null;
  let timeoutId = null;

  try {
    const cleanHandle = handle.replace(/^@/, '');
    const handleAnchor = handle.startsWith("@") ? handle : "@" + handle;
    const targetUrl = `https://www.youtube.com/@${encodeURIComponent(cleanHandle)}`;

    // 1. 設定逾時控制 (25秒)
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 25000);

    // 2. 發起請求
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
      credentials: "include", 
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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

    if (!response.ok) {
      clearTimeout(timeoutId);
      return { error: "Network response was not ok", status: response.status };
    }

    // 3. 串流讀取 (Stream Parsing)
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    let tailBuffer = "";
    const OVERLAP_SIZE = 1000;
    let resultName = null;
    let resultSubs = null;
    let totalLength = 0; // 用來計算總流量

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      totalLength += chunk.length;
      
      // 搜尋範圍 = 上一次的尾巴 + 新的 chunk
      const searchScope = tailBuffer + chunk;

      // === 解析名稱 ===
      if (!resultName) {
        const ogMatch = searchScope.match(/<meta\s+(?:property="og:title"\s+content="([^"]+)"|content="([^"]+)"\s+property="og:title")>/i);
        if (ogMatch) {
            resultName = (ogMatch[1] || ogMatch[2]).replace(/\s*-\s*YouTube$/, "").trim();
        }
        if (!resultName) {
           const twMatch = searchScope.match(/<meta\s+name="twitter:title"\s+content="([^"]+)">/i);
           if (twMatch) resultName = twMatch[1];
        }
        if (!resultName) {
           const jsonMatch = searchScope.match(/"name":\s*"([^"]+)"/);
           if (jsonMatch && !jsonMatch[1].includes("Google")) {
               resultName = jsonMatch[1];
           }
        }
      }

      // === 解析訂閱數 ===
      if (!resultSubs) {
        // 每次都在目前的視窗範圍內從頭找，因為 searchScope 不會無限長大
        let lastCheckIndex = 0; 
        let anchorIndex = searchScope.indexOf(handleAnchor, lastCheckIndex);
        
        while (anchorIndex !== -1) {
          const snippet = searchScope.slice(anchorIndex, anchorIndex + 2000); 
          const textOnly = snippet.replace(/<[^>]+>/g, " ");

          const subRegex = /([\d,.]+[KMB萬億]?)\s*(?:位?訂閱者|subscribers)/i;
          const m = textOnly.match(subRegex);
          
          if (m) {
            const rawString = m[1];
            // 注意: 這裡需要確保 parseSubsString 函式在 background.js 中可被呼叫 
            const numericVal = parseSubsString(rawString);

            if (numericVal >= 500) {
                resultSubs = rawString; 
                break; 
            }
          }
          lastCheckIndex = anchorIndex + 1;
          anchorIndex = searchScope.indexOf(handleAnchor, lastCheckIndex);
        }
      }

      // 更新 tailBuffer (保留最後一段，供下一次拼接)
      if (searchScope.length > OVERLAP_SIZE) {
          tailBuffer = searchScope.slice(-OVERLAP_SIZE);
      } else {
          tailBuffer = searchScope;
      }

      // 檢查 totalLength
      if ((resultName && resultSubs) || totalLength > 3 * 1024 * 1024) {
        reader.cancel(); 
        break;
      }
    }

    clearTimeout(timeoutId);

    if (resultName) {
      const numericSubs = resultSubs ? parseSubsString(resultSubs) : 0;
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

// 輔助函式：將訂閱數縮寫 (如 1.2M) 轉換為數值
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