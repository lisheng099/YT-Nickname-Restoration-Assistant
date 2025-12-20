// ===========================================================
// yt_parser.js - YouTube 頁面解析器
// 用途：負責解析 HTML 原始碼，提取頻道名稱與訂閱數。
// ===========================================================

const YTParser = {
  // 主解析函式
  parse: function(htmlText) {
    if (!htmlText) return null;

    // 1. 提取 ytInitialData JSON
    // 這是 YouTube 存放頁面資料的核心物件
    const jsonMatch = htmlText.match(/ytInitialData\s*=\s*({.+?});/);
    if (!jsonMatch) {
        return null; // 找不到資料結構
    }

    let jsonData;
    try {
        jsonData = JSON.parse(jsonMatch[1]);
    } catch (e) {
        console.error("[YTParser] JSON Parse Error", e);
        return null;
    }

    // 2. 遍歷 JSON 尋找資料
    // YouTube 的 JSON 結構很深，需層層確認
    let name = null;
    let subs = null;

    const pageHeader = jsonData.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
    
    if (pageHeader) {
      // 抓取名稱
      name = pageHeader.title?.dynamicTextViewModel?.text?.content;

      // 抓取訂閱數 (通常在 metadataRows 的不同位置)
      const rows = pageHeader.metadata?.contentMetadataViewModel?.metadataRows;
      
      if (rows && rows.length > 1) {
        // 情況 A: 標準版面，訂閱數在第二行
        const parts = rows[1].metadataParts;
        if (parts && parts.length > 0) {
          subs = parts[0].text?.content;
        }
      } else if (rows && rows.length > 0) {
        // 情況 B: 簡約版面，嘗試在第一行尋找關鍵字
        const parts = rows[0].metadataParts;
        if (parts) {
          const subPart = parts.find(p => p.text?.content && (p.text.content.includes("訂閱") || p.text.content.includes("subscribers")));
          if (subPart) subs = subPart.text.content;
        }
      }
    }

    // 如果連名字都找不到，視為解析失敗
    if (!name) return null;

    // 3. 數值格式化
    // 將 "1.5萬" 或 "1.2M" 轉換為純數字，並過濾過小的數值
    let numericSubs = subs ? this.parseSubsString(subs) : 0;
    if (numericSubs < 500) numericSubs = 0; // 過濾 500 以下的訂閱數

    return { 
        nameRaw: name, 
        subs: numericSubs 
    };
  },

  // 輔助函式：將訂閱數字串轉為數字
  parseSubsString: function(str) {
    if (!str) return 0;
    // 移除所有非數字和小數點的字元
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
};