# 套件現況

本檔記當前已開發功能之最新狀態(各功能做到哪裡、對應之規則帳本條目與測試檔、已知缺口與待辦、最近一次驗證或發布之版本),只記現況、不寫過程(過程寫入經驗檔).接續工作先讀本檔.

最近驗證:2026-11-01,`npm test`(`mocha --parallel "test/*.test.mjs"`,經 `quiet-run --lock`)150 passing;`package.json` version 1.0.23(本輪未改版、未發布);依賴 `wsemi ^1.9.39`.

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

匯入方式:主入口 `WDataPipeline`(預設匯出物件)含上列 11 個新名稱為屬性;亦可自深層路徑具名匯入(`src/lock/executionLock.mjs`、`src/budget/deadline.mjs`、`src/budget/budget.mjs`、`src/log/runLogger.mjs`),兩者為同一引用(R6).

## 已知缺口與待辦

- 主入口不提供 ESM 具名匯出(會使 UMD `require()` 形狀變成 `{ default, … }`,見 R6);具名匯入走深層路徑.
- 預設實作引入 `fs`／`path`:UMD 建置時被視為外部模組(rollup 警告「Creating a browser bundle that depends on Node.js built-in modules」);本套件實務上已綁 LMDB(僅 Node),如需瀏覽器端載入須另議.
- 發布後待辦(非本套件):4 套件(w-knowledge-capture 及其下游 3 套件)與專案端改自 `w-data-pipeline/src/…` 取用;srcRunner 刪除 `core/lock.mjs`、`core/deadline.mjs`、`core/budget.mjs`、`core/ops/logger.mjs`(由主控安排).
- 集合層待裁示事項見 R1「待裁示」.
