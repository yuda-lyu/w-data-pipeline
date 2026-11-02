# 套件現況

本檔記當前已開發功能之最新狀態(各功能做到哪裡、對應之規則帳本條目與測試檔、已知缺口與待辦、最近一次驗證或發布之版本),只記現況、不寫過程(過程寫入經驗檔).接續工作先讀本檔.

最近驗證:2026-11-02(r3pl),`npm test`(`mocha --parallel "test/*.test.mjs"`,經 `quiet-run --lock`)222 passing(改前 150＋新增 `unit-oneline` 72);`package.json` version 1.0.24(本輪未改版、未發布);依賴 `wsemi ^1.9.44`(自 ^1.9.39 升,升後改前碼 150 案全綠).

## 功能與狀態

| 功能 | 做到哪裡 | 規則帳本 | 測試檔 |
|---|---|---|---|
| 管道 `definePipeline`／`runPipeline`／`defineStage`／`createContext`(逐段計時、失敗隔離、停止與收尾、可巢狀、`spec.lock`／`spec.deadlineMs`／`spec.log` 注入介面) | 完成;介面未變 | — | `test/unit-pipeline.test.mjs` |
| 抓取器 `defineFetcher`／`createFetcherRegistry`／`runListFetch`／`runDetailFetch` | 完成 | — | `test/unit-fetch-runner.test.mjs` |
| 去重 `createSeenStore`／`createIdentity`／`keyOf` | 完成 | — | `test/unit-identity-dedup.test.mjs` |
| 集合層 `openCollection`／`withCollections` | 完成;`insertNew`／`count` 之逐筆結果檢查與若干既有行為待裁示 | R1–R4 | `test/unit-open-collection.test.mjs` |
| 執行鎖預設實作 `acquireLock`／`inspectLock`(`spec.lock`) | 完成(自 srcRunner 移入,Gitea #39);行為與契約不變 | R5、R6 | `test/unit-lock.test.mjs`、`test/unit-default-impl.test.mjs` |
| 截止推導 `deadlineMsOf`／`parseIsoDuration`／`DEADLINE_MARGIN_MS`／`DEADLINE_FLOOR_MS`(`spec.deadlineMs`) | 完成(同上) | R5 | `test/unit-deadline.test.mjs`、`test/unit-default-impl.test.mjs` |
| 預算介面 `budgetOf`／`reserveOf`／`reserveMsOf`(各段消費剩餘時間) | 完成(同上) | R5 | `test/unit-budget.test.mjs`、`test/unit-default-impl.test.mjs` |
| 落檔日誌預設實作 `createRunLogger`／`createLogger`(`spec.log`) | 完成(同上);`cliFail` 委派 wsemi `execCliFailDetail` | R5、R7 | `test/unit-run-logger.test.mjs`、`test/unit-default-impl.test.mjs` |
| 壓行限長 `oneline`(日誌訊息用;`src/util/oneline.mjs`) | 完成;`n` 由本函數自行以 `iseint` count 判定,有效才轉數字交 wsemi `strTruncate`,無效回壓平整行(wsemi 第 3 輪下游先行,不再依賴 `strTruncate` 對無效 `maxLen` 之寬鬆處置);第 3 輪嚴格版替身下不拋錯 | R7⑤、R8 | `test/unit-oneline.test.mjs`(輔助 `test/tools/`) |

匯入方式:主入口 `WDataPipeline`(預設匯出物件)含上列 11 個新名稱為屬性;亦可自深層路徑具名匯入(`src/lock/executionLock.mjs`、`src/budget/deadline.mjs`、`src/budget/budget.mjs`、`src/log/runLogger.mjs`),兩者為同一引用(R6).

## 已知缺口與待辦

- 主入口不提供 ESM 具名匯出(會使 UMD `require()` 形狀變成 `{ default, … }`,見 R6);具名匯入走深層路徑.
- 預設實作引入 `fs`／`path`:UMD 建置時被視為外部模組(rollup 警告「Creating a browser bundle that depends on Node.js built-in modules」);本套件實務上已綁 LMDB(僅 Node),如需瀏覽器端載入須另議.
- 發布後待辦(非本套件):4 套件(w-knowledge-capture 及其下游 3 套件)與專案端改自 `w-data-pipeline/src/…` 取用;srcRunner 刪除 `core/lock.mjs`、`core/deadline.mjs`、`core/budget.mjs`、`core/ops/logger.mjs`(由主控安排).
- 集合層待裁示事項見 R1「待裁示」.
- `oneline` 對 4 種舊寬鬆無效 `n`(`'0x10'`、`'0b11'`、`new Number(5)`、`new String('5')`)由截斷改為不截斷(R8);站內呼叫端皆傳字面數字,無影響;待主控確認可接受(派工單曾假設包裝物件新舊相同,實測不同).
- wsemi 第 3 輪(主控稍後改 wsemi)後,本套件待再驗:`npm test` 全綠,`test/unit-oneline.test.mjs` 之差分基準自帶寬鬆版 `strTruncate` 複本,不受 wsemi 改動影響.
- `oneline` 的 JSDoc 稱截斷後補「…」,實際輸出為 ASCII `...`(wsemi `strTruncate`):文件字面與輸出不符,本輪輸出須逐字不變故未動文字.
