// ===========================================================
// yt_parser.js - YouTube 頁面解析器
// 用途：負責解析 HTML 原始碼，提取頻道名稱與訂閱數。
// ===========================================================

const YTParser = {
  // 主解析函式
  parse: function (htmlText) {
    if (!htmlText) return null;

    let name = null;
    let subs = null;

    // 1. 提取 ytInitialData JSON (YouTube 存放頁面資料的核心物件)
    const jsonData = this.extractInitialData(htmlText);

    if (jsonData) {
      const pageHeader =
        jsonData.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;

      if (pageHeader) {
        name = pageHeader.title?.dynamicTextViewModel?.text?.content;
        subs = this.findSubsText(
          pageHeader.metadata?.contentMetadataViewModel?.metadataRows
        );
      }

      // 備援 1: 舊版 Header 與頻道 Metadata
      if (!name) {
        name =
          jsonData.header?.c4TabbedHeaderRenderer?.title ||
          jsonData.metadata?.channelMetadataRenderer?.title ||
          null;
      }
      if (!subs) {
        subs =
          jsonData.header?.c4TabbedHeaderRenderer?.subscriberCountText
            ?.simpleText || null;
      }
    }

    // 備援 2: ytInitialData 取不到名稱時，改讀 <meta property="og:title">
    if (!name) name = this.extractMetaTitle(htmlText);

    // 如果連名字都找不到，視為解析失敗
    if (!name) return null;

    // 2. 數值格式化
    // 將 "1.5萬" 或 "1.2M" 轉換為純數字，並過濾過小的數值
    let numericSubs = subs ? this.parseSubsString(subs) : 0;
    if (numericSubs < 500) numericSubs = 0; // 過濾 500 以下的訂閱數

    return {
      nameRaw: name,
      subs: numericSubs,
    };
  },

  // 以括號配對擷取 ytInitialData，字串內容含有 "};" 時也能完整取出
  extractInitialData: function (htmlText) {
    const marker = /ytInitialData\s*=\s*/g;
    let m;
    while ((m = marker.exec(htmlText)) !== null) {
      const start = m.index + m[0].length;
      if (htmlText[start] !== "{") continue;
      const jsonText = this.sliceBalancedObject(htmlText, start);
      if (!jsonText) continue;
      try {
        return JSON.parse(jsonText);
      } catch (e) {
        // 這個位置不是完整的 JSON，繼續找下一個
      }
    }
    return null;
  },

  // 從 start (必須是 "{") 開始，回傳括號配對完整的物件字串
  sliceBalancedObject: function (text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  },

  // 在 metadataRows 中找出訂閱數文字
  findSubsText: function (rows) {
    if (!Array.isArray(rows)) return null;
    const texts = [];
    for (const row of rows) {
      for (const part of row.metadataParts || []) {
        const content = part.text?.content;
        if (content) texts.push(content);
      }
    }
    // 優先找含有「訂閱」關鍵字的欄位
    const byKeyword = texts.find((t) => this.SUBS_KEYWORDS.test(t));
    if (byKeyword) return byKeyword;

    // 標準版面：訂閱數在第二行第一格
    if (rows.length > 1) {
      return rows[1].metadataParts?.[0]?.text?.content || null;
    }
    return null;
  },

  SUBS_KEYWORDS: /訂閱|订阅|subscriber|登録者|구독자/i,

  extractMetaTitle: function (htmlText) {
    const m =
      htmlText.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ||
      htmlText.match(/<meta\s+content="([^"]*)"\s+property="og:title"/i);
    if (!m || !m[1]) return null;
    // HTML 實體由前台的 decodeHtmlEntities 統一解碼
    return m[1].trim() || null;
  },

  // 輔助函式：將訂閱數字串轉為數字
  parseSubsString: function (str) {
    if (!str) return 0;
    const numMatch = String(str).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (!numMatch) return 0;
    let val = parseFloat(numMatch[0]);
    if (isNaN(val)) return 0;

    // 只看數字後面的單位，避免 "subscribers" 的字母被誤判
    const rest = String(str)
      .replace(/,/g, "")
      .slice(numMatch.index + numMatch[0].length)
      .trim();
    const unit = rest.charAt(0);
    const unitUpper = unit.toUpperCase();

    if (unit === "億" || unit === "亿" || unit === "억") val *= 100000000;
    else if (unit === "萬" || unit === "万" || unit === "만") val *= 10000;
    else if (unit === "千" || unit === "천") val *= 1000;
    else if (unitUpper === "K") val *= 1000;
    else if (unitUpper === "M") val *= 1000000;
    else if (unitUpper === "B") val *= 1000000000;

    return Math.floor(val);
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { YTParser };
}
