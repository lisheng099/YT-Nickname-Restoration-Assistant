# 瀏覽器整合測試

以 Chromium 實際載入擴充功能，並把 `https://www.youtube.com/live_chat` 導向 `mock_chat.html`。
模擬頁面只重現聊天訊息的基本結構 (`yt-live-chat-text-message-renderer`、`#author-name`、元素上的 `.data`)，
用來驗證擴充功能自己的流程；YouTube 實際頁面的結構變化需要在真實頁面上另外確認。

```bash
npm install --no-save playwright   # 環境中已有 Playwright 時可省略
npm run test:e2e
```

`EXT_DIR` 可指定要載入的擴充功能資料夾，`SHOT_DIR` 可指定截圖輸出的資料夾。
