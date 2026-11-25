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
