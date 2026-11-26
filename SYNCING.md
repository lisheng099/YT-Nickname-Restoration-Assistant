# 同步說明(維護者用)

這個 repo 是 [StreamMemo](https://github.com/lisheng099/StreamMemo) `extension-viewer/` 的鏡像,單獨發布觀眾版擴充。

- **不要直接在這裡改程式。** 改 StreamMemo 的 `extension-viewer/`;兩個擴充共用的檔案(`js/shared/*`、`js/libs/idb-keyval.js`、
  `js/background/{bg_cache,bg_fetcher,yt_parser}.js`、`js/content/{scanner,data_bridge,page_probe}.js`,含筆記核心
  `js/shared/notes_core.js`)要改 StreamMemo 的 `extension-shared/`,再執行 `node scripts/sync-shared.mjs`。
- 在 StreamMemo 根目錄把改動帶過來:

  ```
  node scripts/sync-viewer-repo.mjs <這個 repo 的本機路徑> --check   # 只列出差異
  node scripts/sync-viewer-repo.mjs <這個 repo 的本機路徑>           # 複製並刪掉多餘的檔案
  ```

- 只存在這個 repo 的檔案不會被動到:`.github/`、`.gitattributes`、`.gitignore`、`SYNCING.md`。
- `tests/e2e/viewer.e2e.js` 只放在 StreamMemo:它要用主播版的瀏覽器測試工具(`extension/tests/e2e/harness.js`)。

## 名稱放在原本的名稱元素裡(不可改回)

還原後的頻道名稱(`js/content/ui.js` 的 `renderDual`)與自訂暱稱(`js/shared/name_target.js` 的 `setCustomName`)
都放在 YouTube 原本的名稱元素**裡面**(聊天室 `#author-name`、留言 `#author-text`),不要改回「隱藏名稱元素、
在旁邊另放一份複製樣式的名稱」。舊做法讓直播畫面 / Stylus 的自訂聊天室 CSS 選不到名稱,之後才載入的樣式、
陰影與 `::before` / `::after` 都不會套上,名稱旁的徽章圖示也會消失。完整原因與規則見 StreamMemo 的
`extension-shared/README.md`「名稱放在原本的名稱元素裡」,測試是 StreamMemo 的 `tests/e2e/name_style.e2e.js`。
