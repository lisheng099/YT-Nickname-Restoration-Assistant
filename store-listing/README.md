# 觀眾版商店上架文字

| 檔案 | 貼到哪裡 |
| --- | --- |
| `en.txt` | Chrome Web Store 後台 →「商店資訊 (Store listing)」→ 語言選 English →「說明 (Description)」 |
| `zh-TW.txt` | 同上，語言選「中文 (台灣)」 |
| `zh-CN.txt` | 同上，語言選「中文 (中国)」 |
| `ja.txt` | 同上，語言選「日本語」 |
| `privacy-practices.txt` | 「隱私權實務 (Privacy practices)」分頁：單一用途、storage／主機權限理由、遠端程式碼、資料使用 |

- 商店上的名稱與簡短說明來自 `_locales/*/messages.json` 的 `appName` / `appDesc`（隨 zip 上傳，後台不用另外填；`appDesc` 上限 132 字元）。
- 功能、上限或權限有變動時，四個語言檔與 `privacy-practices.txt` 要一起改，並對照 `manifest.json`。
