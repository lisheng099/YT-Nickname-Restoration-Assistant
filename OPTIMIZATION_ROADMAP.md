# 抓取與替換策略優化規劃 (Optimization Roadmap)

本文件整理針對 YouTube 近期介面改版、DOM 掃描、後端抓取與元素替換機制的問題分析與改進規劃。

---

## 一、待補齊的 YouTube 目標區塊與選擇器 (`js/content/scanner.js`)

目前 `PageScanner.targetConfigs` 共定義 17 個選擇器（最後更新於 `v1.1.0` 的 `yt-gift-message-view-model #author-name`）。針對近期 YouTube 介面與常見互動情境，建議擴充以下區塊：

1. **留言區與聊天室內的 `@mention` 標註連結**
   - **情境**：回覆他人留言（如 `@someone 謝謝`）或內文提及頻道時，YouTube 會產生指向 `/@handle` 的連結，目前僅替換了作者欄位，內文提及的對象仍顯示為 `@handle`。
   - **目標選擇器**：
     - `yt-attributed-string a[href^="/@"]`
     - `yt-formatted-string a[href^="/@"]`
2. **直播聊天室付費貼圖 (Super Stickers)**
   - **情境**：Super Chat 文字訊息已涵蓋，但付費貼圖使用獨立 renderer。
   - **目標選擇器**：`yt-live-chat-paid-sticker-renderer #author-name`
3. **YouTube Studio 後台留言管理 (`studio.youtube.com`)**
   - **情境**：`manifest.json` 已宣告 `https://studio.youtube.com/*` 權限，但 `targetConfigs` 僅有前台 `ytd-*` / `yt-live-chat-*` 選擇器。
   - **目標選擇器**：Studio 內 `ytcp-comment` 相關作者名稱節點。
4. **Shorts 留言面板與新版 ViewModel 結構**
   - **情境**：Shorts 側邊/彈出留言面板或實驗性 `yt-attributed-string` 渲染之作者名稱。

---

## 二、MutationObserver 掃描與優先權優化 (`js/content/scanner.js`)

### 1. 修正 `handleMutations` 白名單過濾與 `targetConfigs` 脫節問題
- **現況問題**：
  `handleMutations` 在處理 `addedNodes` 時，硬編碼只檢查節點 tag 是否包含 `yt-live-chat`、`ytd-comment`、`ytd-item-section-renderer`、`ytd-pinned-comment`，或子孫是否含有 `ytd-comment-view-model` / `yt-live-chat-text-message-renderer`。
  這導致 `targetConfigs` 中的 **`yt-gift-message-view-model`**（禮物訊息）或 **`ytd-sponsorships-live-chat-*`**（會員贈禮公告）在單獨動態插入時可能被直接略過。
- **改進方案**：
  移除硬編碼的標籤字串判斷，改為直接以 `node.matches(this.masterSelector)` 或 `node.querySelector(this.masterSelector)` 檢查，確保所有在 `targetConfigs` 註冊的選擇器皆能自動生效。

### 2. 導入 `IntersectionObserver` 實現「可視區域優先抓取」
- **現況問題**：
  當影片留言區一次載入大量留言時，`scanDeep` 會依 DOM 順序將所有未快取的 `@handle` 推進 `BgFetcher.queue.low`（每筆間隔 1.2～2.5 秒）。若使用者直接向下捲動至中段留言，必須等待上方數十筆留言全部抓完才能看到當前畫面的暱稱。
- **改進方案**：
  結合 `IntersectionObserver` 監測進入 Viewport（可視範圍）的目標元素：
  - 進入畫面且尚未完成抓取的元素，發送請求時帶入 `priority: "high"` 或觸發 `BgFetcher.promoteTask`。
  - 確保使用者眼前正在閱讀的留言與聊天室訊息永遠優先還原。

---

## 三、DOM 替換與防回收策略優化 (`js/content/ui.js` & `scanner.js`)

### 1. 「雙節點分離法」取代直接覆寫 `textContent`
- **現況問題**：
  `TooltipManager.renderStandard` 會執行 `target.textContent = ""` 將原始文字清空並換成暱稱。當 YouTube 的 Polymer / Lit 框架在虛擬捲動（Virtual Scroll）回收並重用 DOM 節點時：
  - 原生框架可能因找不到原有的 TextNode 而產生非預期行為或殘留舊暱稱。
  - 原生 `@handle` 文字被洗掉後，只能依賴 `dataset.rnTargetHandle` 輔助判斷。
- **改進方案**：
  - 保留 YouTube 原生寫入 `@handle` 的文字節點（透過 CSS 隱藏或封裝），並在旁插入擴充功能專屬的 `<span class="rn-restored-name">` 顯示還原後的暱稱與徽章。
  - 當原生文字節點被 YouTube 更新時，可直接讀取原生節點最新的 `@handle` 與 `dataset.rnTargetHandle` 比對，徹底避免聊天室高速捲動時「張冠李戴」的問題。

### 2. 結合 `<a href="/@handle">` 屬性提取 Handle
- **現況問題**：
  目前完全依賴 `el.textContent` 的正則表達式提取 `@handle`。
- **改進方案**：
  留言區與部分聊天室元素本身或外層即為 `<a href="/@...">` 連結。優先或輔助從 `href`（搭配 `decodeURIComponent`）提取 Handle，即使顯示文字被截斷或已被替換，仍能精準識別目標頻道。

---

## 四、後端資料抓取與解析效率優化 (`js/background/bg_fetcher.js` & `yt_parser.js`)

### 1. Fetch 串流提早中斷 (ReadableStream Early Abort)
- **現況問題**：
  每次抓取 `https://www.youtube.com/@handle` 都會下載完整的頻道頁面 HTML（常達數百 KB），但 `<meta property="og:title">` 與 `ytInitialData` 通常位於回應的前段。
- **改進方案**：
  使用 `response.body.getReader()` 逐步讀取區塊，一旦擷取到完整的 `ytInitialData`（或 `</head>` 加上所需的 script 區塊）即可透過 `AbortController` 提早中斷連線，大幅節省頻寬與記憶體消耗。

### 2. 善用頁面既有 YouTube 內部資料 / 輕量端點
- **改進方案**：
  - **前台資料攔截**：YouTube 頁面在載入留言（`youtubei/v1/next`）或聊天室（`live_chat/get_live_chat`）時，部分元件或回應資料已包含頻道中繼資訊，可於前台先行提取以減少背景佇列請求數。
  - **Innertube / 輕量請求備援**：評估以輕量 API 請求作為備援，降低完整 HTML 抓取頻率與觸發 HTTP 429 的風險。
