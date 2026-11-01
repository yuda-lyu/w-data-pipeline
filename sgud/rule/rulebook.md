# 規則帳本

本檔為套件設計與開發階段之規則帳本,為要求程式碼須長成什麼樣,或由規格產出之測試(項目/說明/流程)有哪些,包含軸、單一擁有者、已知限制、破壞性變更紀錄,以及對應是哪些測試檔案或指令等,由agent自行編列、擴充與維護.

## R1 集合層寫入必檢查逐筆結果(fail-closed)

**規則**:`src/dedup/openCollection.mjs` 內,凡呼叫傳入 WOrm 之寫入函數(`save`/`del`/`insert`),其回傳之逐筆結果必須被檢查並據以判定成敗,不得丟棄.WOrm(w-orm-lmdb)對單筆失敗不 reject,而以 `{ ok:0, err }` 回報,「由呼叫端逐筆檢查」;集合層即是該呼叫端.w-orm 系列規定 `ok` 僅 `1`/`0`,故**只認 `ok === 1` 為成功**(結果缺漏、`ok` 為其他任何值皆視為失敗),失敗一律拋錯,訊息帶 `cl`、`id` 與 `err`;集合層不把記錄內容放進訊息,但 `err` 為儲存層原文、原樣轉出(編碼錯誤可能引述欄位值,本層無從過濾,文件已如實寫明).

**why**:丟棄逐筆結果 = fail-open,寫入失敗呼叫端完全不知(建議書第 2 項;下游 94 處呼叫 `patch`).

**站點全集與判準**(盤點指令:`Grep "wo\.(save|del|insert)\(" src/dedup/openCollection.mjs`):

| 站點 | 判準 | 狀態 |
|---|---|---|
| `patch` → `wo.save` | 已檢查逐筆結果,`ok:0` 拋錯 | 已套 |
| `replace` → `wo.save(…,{merge:false})` | 已檢查逐筆結果,`ok:0` 拋錯 | 已套 |
| `del` → `wo.del` | 已檢查逐筆結果,`ok:0` 拋錯;回傳 `nDeleted === 1` | 已套 |
| `insertNew` → `wo.insert(…,{returnList:true})` | 以 `lt[i]?.nInserted === 1` 反推新增,`ok:0`/缺項被計為重複(dup) | **未套,待裁示**(w-orm-lmdb 之 insert 錯誤皆整批 reject,逐筆恆 ok:1,故現行後端下不發生;換成他後端才有風險;不在本次範圍) |
| `count` → `wo.select` | 非陣列回 0(掩蓋異常) | **未套,待裁示**(讀取路徑,非逐筆寫入結果) |
| `close` → `wo.close` | 吞錯 | 刻意不套(註解已述「關閉失敗不影響已寫入資料」) |
| `probeMergeFalse` → `pw.save`(種入/覆寫) | 已以 `assertSaved` 檢查,失敗視為自檢未完成(拋錯、不快取) | 已套 |
| `probeMergeFalse` → `pw.del`/`pw.close`(清理) | 吞錯 | 刻意不套(殘留只在保留集合 `__wdp_probe__`,不影響業務集合,下次自檢用新 id;不因清理失敗推翻已得判定;不遮蔽主錯誤) |

**待裁示(外審提出、既有行為或上游限制,本次未改)**:①`del` 不 trim id,與 `get`/`patch`/`replace`/`insertNew` 之 trim 不一致,`del(undefined)` 會刪字面鍵 `"undefined"`(舊版即如此;建議統一走 `assertId`,屬相容性變更);②`replace(null/undefined)` 拋 `TypeError` 而非 `ContractError`(舊版即如此);③`patch(id, fields)` 未檢查 `fields` 型別(舊版即如此);④整批 reject(如已 close)之錯誤原樣外拋,不帶 `cl`/`id`(逐筆失敗才帶);⑤w-orm-lmdb 1.0.41 之 `del` 先讀存在再刪、非同一交易,併發刪同一 id 可能多個回 `nDeleted:1`(上游,已於 JSDoc/README 載明限制);⑥`insertNew`/`count` 見上表.

**測試**:`test/unit-open-collection.test.mjs`(R1 區塊);指令 `npx mocha --no-parallel test/unit-open-collection.test.mjs --timeout 180000`.

## R2 `replace` 須單一寫交易、不經刪除

**規則**:`replace(rec)` 必須以 `wo.save([{ ...rec, id }], { merge: false })` 於 WOrm 同一寫交易內整筆覆寫(舊記錄不在新記錄之鍵不保留、陣列整筆替換);不得出現「先 `del` 再 `insert`」兩步寫入.

**why**:兩步之間無交易 —— ①刪後插前失敗 → 原記錄消失;②刪後插前他者插入同 id → 本次寫入無聲遺失(建議書第 1 項).

**盤點指令**:`Grep "wo\.del|wo\.insert\(" src/dedup/openCollection.mjs` —— `replace` 函數體內不得出現 `wo.del`/`wo.insert`;`wo.del` 只允許出現在 `del`(及探針清理)內.

## R3 `replace` 須在確認 WOrm 支援 `merge:false` 後才寫入(不得靜默降級)

**規則**:`merge:false` 為 w-orm-lmdb >= 1.0.41 之選項.WOrm 由呼叫端傳入,若為舊版或他後端,選項會被忽略而當成深合併,舊鍵殘留且無任何錯誤.故 `replace` 在對真實集合寫入**之前**,須對該 WOrm 建構函數做一次性自檢(同 path/db 之隔離探針集合,不碰真實集合之任何記錄):先存 `{id,keep,drop,arr:[1,2,3],nest:{a:1,b:1}}`,再以 `{merge:false}` 存 `{id,keep,arr:[9],nest:{a:2}}`,讀回須恰為後者(頂層刪鍵、陣列整筆替換、巢狀物件刪鍵三者皆驗),否則判為不支援.不支援者拋 `ContractError`,訊息含「w-orm-lmdb >= 1.0.41」,真實集合不被改動.判定結果以 WOrm 建構函數為鍵快取(WeakMap).**判定分兩種**:讀回記錄存在且 id 相符而內容不符 → 確定不支援(終態、快取);查無探針記錄或 id 不符、種入/覆寫 `ok` 非 1、探針實例建不起來 → 無法判定(一般 `Error`、不快取、下次重試).`__wdp_probe__` 為保留 cl 名,`openCollection` 拒收.

**前提(已文件化,不在支援範圍者)**:支援度視為 WOrm 建構函數之性質,對任何 cl/path/db 一致;會依 cl/path/db 分派到不同後端或版本之工廠,探針結果不能代表業務集合(外審 sol 以此提出,屬設計前提而非可由程式補救;改法需要適配器提供能力宣告或對目標實例原子 replace 原語).

**取捨**:①覆寫後讀回比對鍵集合 —— 偵測時資料已被誤合併,無法滿足「資料不被誤改」,且儲存值為編碼往返結果,鍵集合比對易誤報,故不採為唯一手段;②開集合時自檢 —— `openCollection` 為同步函數無法 await,且不用 `replace` 者不應受牽連,故改為首次 `replace` 時惰性自檢;③探針放同集合(保留 id)—— 會讓真實集合在自檢期間(或行程中斷後)出現非業務記錄,污染 `select`/`count`,故放隔離之探針集合(代價:同 path/db 下多一個空的 `__wdp_probe__` 資料夾;w-orm-lmdb 每個 cl 是獨立 LMDB 環境資料夾 `${url}/${db}/${cl}`).

**測試**補充:`unit-open-collection.test.mjs` 另含:巢狀物件仍深合併之替身判不支援、自檢讀回異常屬無法判定(一般 Error、不快取、恢復後成功)、保留名拒收、同 id 多個 replace 併行(含首次自檢同時進行)之最終值恰為其中一筆完整記錄.變異驗證(`tmp/mutate.mjs`,13 個變異)全數轉紅.

**測試**:同上 R1 測試檔之 R3 區塊(不支援 merge 之替身 WOrm 呼叫 replace 必拋錯、資料不被誤改).

## R4 集合層 find 之說明與 w-orm 系列條件白名單一致(透傳,不另檢核)

**規則**:`src/dedup/openCollection.mjs` 之 `select(find)`、`count(find)` 把 find 原樣交注入之 WOrm,說明須與系列條件白名單一致(dspec〈一之三〉): 欄位等值 `{欄:純量}`、`$eq $ne $gt $gte $lt $lte`(值為純量)、`$in $nin`(值為純量陣列)、文件層 `$and $or`;不給 find(未給、`undefined`、`{}`)為全部;傳了值卻不是條件物件或使用白名單外運算子(`$regex $not $exists` 等)由 WOrm 整批 reject.本層為透傳出口,**不另檢核、不改寫 find**,故不得再稱「mingo 語法」.

**why**:各 w-orm-* 後端已把關白名單(第 33 項批 1),集合層若仍寫「mingo 語法」會讓開發者誤以為 `$regex`、`$not` 等可用;改寫 find 或另設檢核會與後端漂移(方案 §5.2:透傳出口只更新註解).

**盤點指令**:`Grep "mingo|find" src/dedup/openCollection.mjs`(不得有「mingo」;`select`、`count` 各一處說明).

**站點全集與判準**(2026-10-19):`select` 之 JSDoc(已套)、`count` 之 JSDoc(已套);`wo.select(find)` 透傳 2 處(`select`、`count`):刻意不檢核(白名單由 WOrm 把關).

**測試**:無新增(僅註解變更,行為不變);`npm test` 104 案全綠為不變證據.

## R5 預設實作(執行鎖／截止／預算／日誌)之行為與契約以 srcRunner 原始碼為準,不改語意(Gitea #39)

**規則**:`src/lock/`、`src/budget/`、`src/log/` 四組件(自 srcRunner `core/lock.mjs`、`core/deadline.mjs`、`core/budget.mjs`、`core/ops/logger.mjs` 移入)為 `spec.lock`／`spec.deadlineMs`／ctx 時間預算消費／`spec.log` 之**可選預設實作**(外部仍可注入自有實作,`definePipeline` 介面不變)。下列為**契約**,改動須連動消費端(4 個下游套件之巡檢與日誌解析、`略過本輪` 字樣比對),不得單方改字:

| 契約 | 內容 | 位置 |
|---|---|---|
| 常數 | 預設陳舊期限 3600000、持鎖者宣告上限 7 天、空鎖檔寬限 2000ms、取鎖至多兩回合 | `src/lock/executionLock.mjs` |
| 訊息字面 | 「另一個執行中（pid X，已執行 Ns，陳舊期限 N 分（持鎖者宣告））」(含「，鎖時刻在未來（時鐘回撥）」尾綴)、「另一個執行中（鎖檔建立中）」、「本行程已持有此鎖（&lt;file&gt;）：同一行程內不可重複取得」、「另一個執行中（鎖檔於清除後即被他實例取得）」 | 同上 `busyMessage`／`acquireLock` |
| 狀態名與回傳形狀 | `none／corrupt／dead／stale／held／self`;`{ state, pid, at, ageMs, staleMs, staleMsFrom, alive, clockSkew, self }`;`{ ok, message, release }` | 同上 |
| 截止常數 | `DEADLINE_MARGIN_MS` 360000、`DEADLINE_FLOOR_MS` 600000;一律取整 | `src/budget/deadline.mjs` |
| 預算介面 | `budgetOf` 回 `{ expired, remainingMs, shouldStop, capMs, capSeat }`;`capSeat` 之 `budgetMs` 為可列舉 getter | `src/budget/budget.mjs` |
| 日誌格式 | 行 `[ISO] LEVEL msg`,LEVEL 字面 `INFO `／`WARN `／`ERROR`(五字元對齊,解析端據此);檔名 `{root}/{day}/{runId}[-{name}].log`;每次執行一檔;open 與建立分離(open 前只輸出 stdout);寫檔失敗吞掉;`log／logWarn／logError` 與 `info／warn／error` 兩套名 | `src/log/runLogger.mjs` |

**why**:srcRunner 混有排程外殼與管線秩序件兩種用途,秩序件依本質歸入本套件;主控裁定行為與契約隨件移動、不改語意(原則:執行秩序只有一份實作)。

**與 srcRunner 原始碼之刻意差異(僅此,皆不改語意)**:①`callerStaleOf` 以 `opt.staleMs ?? null` 取代 `lodash-es/get.js`(呼叫端已確認 opt 為物件,等價;不隱性依賴 wsemi 之轉依賴);②`createLogger.cliFail` 之失敗摘要改用 wsemi `execCliFailDetail`(主控裁定;與原 `cliFailDetail` 同契約,細節差異見下);③檔頭與 JSDoc 僅改檔名、時鐘說明(`util/clock` → 鴨子型別/wsemi `genClockTZ`)並補 `definePipeline` 用法範例。**`execCliFailDetail` 與原 `cliFailDetail` 之細節差異(屬 wsemi 契約;實測 14 類輸入 10 同 4 異,腳本存主控任務夾證據 `pl39-evidence/diff-clifail.mjs`)**:僅在畸形輸入相異——`attempts` 為小數(`1.5`)或負數(`-1`)時原會顯示「，共試 1.5 次」、wsemi 不顯示;`stderr` 非字串(數字、Buffer)時原以 `String(x)` 轉字串顯示、wsemi 視為無.整數(含數字字串 `'3'`)、`0`、`null`／`undefined`／`{}`、多行與超長 stderr 皆相同;`execCli` 實際產出(整數 attempts、字串 stderr)不受影響.

**盤點指令**:`Grep "lodash|from '\.\./util|w-dispatch-ai" src/lock src/budget src/log`(僅 `budget.mjs` 檔頭註解提及 w-dispatch-ai,不得有 import);`Grep "^import" src/lock src/budget src/log`(只允許 `fs`、`path`、`wsemi/src/*`)。

**測試**:`test/unit-lock.test.mjs`(srcRunner `unit-lock` 14 案＋`unit-util:24-75` 4 案,逐字移植,含 8 子行程取鎖與崩潰殘留接管)、`test/unit-budget.test.mjs`(原檔實有 6 個 `it`,派工單／建議檔稱 7 案,以原檔為準)、`test/unit-deadline.test.mjs`(5 案)、`test/unit-run-logger.test.mjs`(`unit-runner:80,100`＋`unit-check-ops:34,39` 共 4 案,另補 4 案:寫檔失敗吞掉、echo 與五字元對齊、兩套方法名同一函數、clock 鴨子型別)、`test/unit-default-impl.test.mjs`(整合 9 案);`it` 標題前綴 `[原檔簡名:行號]` 標原檔行號,`[新增]` 為原測試未覆蓋者。指令 `npx mocha --no-parallel test/unit-lock.test.mjs test/unit-budget.test.mjs test/unit-deadline.test.mjs test/unit-run-logger.test.mjs test/unit-default-impl.test.mjs --timeout 180000`(經 `quiet-run --lock`)。變異證明 26 個全數轉紅(腳本模式見經驗檔)。

## R6 執行鎖登記表 `HELD` 為模組級單一份;主入口與深層路徑須為同一引用

**規則**:`src/lock/executionLock.mjs` 內 `HELD`(`Map`)只有一份,`acquireLock`／`inspectLock` 同檔共用;`src/WDataPipeline.mjs` 之 `acquireLock`／`inspectLock` 屬性與深層路徑之具名匯出為**同一函數引用**(不得包裝、複製)。同一行程內取用同一把鎖者須用同一份本模組,兩份實作各有自己的登記表,混用會互判殘留而接管(兩條管線同時寫同一個資料庫)。

**主入口形狀**:`WDataPipeline.mjs` 維持**只有預設匯出物件**(新增之 11 個名稱為該物件之屬性),**不加** ESM 具名 `export { … }`——實驗證實(腳本存主控任務夾證據 `pl39-evidence/build2.mjs`)主入口同時有 default 與具名匯出時,rollup UMD 之 `require('w-data-pipeline')` 變成 `{ default, acquireLock, … }`,`require(...).definePipeline` 為 `undefined`,破壞既有消費方式。要具名匯入者走深層路徑(`w-data-pipeline/src/lock/executionLock.mjs` 等)。

**盤點指令**:`Grep "new Map\(" src/lock`(恰 1 處);`Grep "^export" src/WDataPipeline.mjs`(恰 `export default`)。

**測試**:`test/unit-default-impl.test.mjs`「單一實作」區塊(11 名稱同一引用;經主入口取得之鎖,深層路徑之 `inspectLock`／`acquireLock` 亦判 `self`／拒絕)；變異 M02、M26 轉紅。

## R7 預設實作之相依邊界

**規則**:①不依賴 w-dispatch-ai(`capSeat` 只對席位物件做鴨子型別淺拷貝與 getter 定義);②`createLogger` 之 `clock` 為鴨子型別,只呼叫 `stamp8()` 與 `iso8`,不 import 任何時鐘實作(測試用 wsemi `genClockTZ` 產生);③`cliFail` 之失敗摘要委派 wsemi `execCliFailDetail`(`wsemi >= 1.9.39`),本套件不內嵌副本;④不 import `lodash-es`(用 wsemi 既有函數與原生語法);⑤`oneline` 維持本套件既有版(`src/util/oneline.mjs`),不動。

**測試**:`unit-run-logger` 之 `[新增] clock 為鴨子型別` 案;盤點指令見 R5。

## 破壞性變更紀錄

- **本次(w-orm-lmdb >= 1.0.41 起)**:`patch`/`replace` 寫入單筆失敗由靜默改為拋錯;`replace` 改為單一交易原子覆寫;`del` 回傳值語意改為「是否真的刪掉」(刪除不存在 id 回 `false`,原恆回 `true`;失敗改為拋錯,原回 `false`);`replace` 要求注入之 WOrm 支援 `merge:false`(w-orm-lmdb >= 1.0.41),否則拋錯.
