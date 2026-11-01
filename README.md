# w-data-pipeline
A pipeline framework for data fetching, deduplication and staged processing.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg) 
[![npm version](http://img.shields.io/npm/v/w-data-pipeline.svg?style=flat)](https://npmjs.org/package/w-data-pipeline) 
[![license](https://img.shields.io/npm/l/w-data-pipeline.svg?style=flat)](https://npmjs.org/package/w-data-pipeline) 
[![npm download](https://img.shields.io/npm/dt/w-data-pipeline.svg)](https://npmjs.org/package/w-data-pipeline) 
[![npm download](https://img.shields.io/npm/dm/w-data-pipeline.svg)](https://npmjs.org/package/w-data-pipeline) 
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-data-pipeline.svg)](https://www.jsdelivr.com/package/npm/w-data-pipeline)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-data-pipeline/global.html).

## Compatibility
`openCollection({ WOrm, path, db, cl })` takes the ORM constructor from the caller (dependency injection). The injected ORM must follow the w-orm-lmdb interface: `select`, `selectByPk`, `insert`, `save`, `del`, `close`, where `save` and `del` report a single-record failure as `{ ok: 0, err }` instead of rejecting.

`replace` additionally requires **w-orm-lmdb >= 1.0.41**: it overwrites the whole record in one write transaction with `save(data, { merge: false })`. Older versions and other backends ignore that option and silently deep-merge, which would leave stale keys behind. So the first `replace` per WOrm constructor runs a one-time self-check on an isolated probe collection `__wdp_probe__` under the same `path` and `db` (the probe record is removed on a best-effort basis and an empty folder remains there; no record of your collection is touched). If the supplied WOrm does not honor `merge: false` (top-level keys, arrays and nested objects are all checked), `replace` throws a `ContractError` mentioning `w-orm-lmdb >= 1.0.41` before writing anything. If the self-check itself cannot finish (for example the probe collection cannot be opened or read back), `replace` throws a plain `Error` and the next call tries again. `patch`, `del` and `insertNew` do not need `merge: false`. Because of that probe collection, `__wdp_probe__` is a reserved `cl` name and `openCollection` rejects it.

The self-check assumes that support for `merge: false` is a property of the WOrm constructor, the same for every `cl`, `path` and `db`. A factory that routes to different backends or versions depending on those arguments is not supported.

## Breaking changes
Collection write failures are no longer silent (requires w-orm-lmdb >= 1.0.41 for `replace`):

- `patch(id, fields)`: a single-record failure (`ok` other than `1`, i.e. `ok: 0` in w-orm-lmdb) now throws an `Error` whose message carries `cl`, `id` and the storage layer's `err` text. The collection layer adds no record content to the message, but `err` is passed through verbatim and an encoder error can quote the offending value. Previously the result was dropped and the call looked successful.
- `replace(rec)`: now a single-transaction overwrite (`save` with `merge: false`) instead of `del` then `insert`. A failed write leaves the original record in place, and there is no gap in which another writer can slip in. A single-record failure throws like `patch`; a supplied WOrm without `merge: false` support throws `ContractError`.
- `del(id)`: resolves to whether a record was really deleted (`true`), and to `false` when the id does not exist (it used to always resolve `true`). A single-record failure, or a rejection such as a closed collection, now throws instead of resolving `false`. The boolean is the storage layer's `nDeleted`: with w-orm-lmdb 1.0.41, several concurrent deleters of the same id can each get `true`, so do not use it to decide who deleted the record. The id is matched as given (not trimmed), unlike `get`, `patch` and `replace`.

## 預設實作（可選）
`definePipeline` 對執行鎖（`spec.lock`）、截止（`spec.deadlineMs`）與日誌（`spec.log`）只約定介面，外部仍可注入自有實作；套件另提供下列**可選之預設實作**（自 srcRunner 移入，行為與契約不變），不用也不影響既有行為。皆可由主入口物件取得，或自深層路徑具名匯入（兩者為同一份實作）：

```alias
import WDataPipeline from 'w-data-pipeline/src/WDataPipeline.mjs'
let { acquireLock, inspectLock, deadlineMsOf, parseIsoDuration, budgetOf, reserveOf, reserveMsOf, createRunLogger, createLogger } = WDataPipeline

//或自深層路徑具名匯入
import { acquireLock, inspectLock } from 'w-data-pipeline/src/lock/executionLock.mjs'
import { deadlineMsOf, parseIsoDuration, DEADLINE_MARGIN_MS, DEADLINE_FLOOR_MS } from 'w-data-pipeline/src/budget/deadline.mjs'
import { budgetOf, reserveOf, reserveMsOf } from 'w-data-pipeline/src/budget/budget.mjs'
import { createRunLogger, createLogger } from 'w-data-pipeline/src/log/runLogger.mjs'
```

`createLogger` 的 `cliFail` 委派 `wsemi` 的 `execCliFailDetail`（需 `wsemi >= 1.9.39`）；`clock` 為鴨子型別，只呼叫其 `stamp8()` 與 `iso8`，不 import 任何時鐘實作（可傳 `wsemi` 的 `genClockTZ` 產物）。本套件不依賴 w-dispatch-ai。

### 執行鎖之預設實作
`acquireLock(file, { staleMs })` 回傳 `{ ok, message, release }`，與 `spec.lock` 介面相容，可直接交給 `definePipeline`：

```alias
let pl = definePipeline({
    name: '抓取彙整',
    stages: [ /* ... */ ],
    lock: () => acquireLock('./data/run.lock', { staleMs: 65 * 60000 }), //staleMs: 本次宣告之陳舊期限(毫秒，預設 3600000)
})
let report = await runPipeline(pl)
if (report.lockSkipped) {
    console.log(report.stopReason)
    // => 另一個執行中（pid 1234，已執行 12s，陳舊期限 65 分（持鎖者宣告））
}
```

- **取得與釋放**：以 `'wx'`（`O_CREAT|O_EXCL`）原子建立鎖檔；已存在時以 `inspectLock` 判定，可接管者（`none`／`corrupt`／`dead`／`stale`）刪除後再建立一次（至多兩回合，同時接管之輸者回 `ok:false`）；父目錄不存在自動建立。`release` 只在鎖檔 nonce 仍為自己時才刪檔，被接管後晚到的 `release` 不會刪掉接管者的鎖；重複 `release` 不拋錯。
- **陳舊期限由持鎖者宣告**：鎖檔記 `{ pid, at, staleMs, nonce }`，他人判定一律以持鎖者宣告之 `staleMs` 為準（長時執行宣告數百分鐘、每小時輪次宣告 65 分共用一把鎖時，輪次不會於 65 分後接管仍在跑的長時執行）；鎖檔無宣告值或宣告值不合理（非正整數、逾 7 天）時退回取鎖者之 `opt.staleMs`。
- **同一行程也互斥**：同一行程內第二次取同一把鎖回 `ok:false`，訊息為「本行程已持有此鎖（&lt;file&gt;）：同一行程內不可重複取得」；鎖檔 pid 為本行程但 nonce 不在行程內登記表者視為前一個同 pid 行程之殘留（可接管）。登記表為**模組級單一份**，故同一行程內取用同一把鎖者須用同一份本模組（主入口與深層路徑匯入者即為同一份；兩份實作各有自己的登記表，混用會互判殘留而接管）。
- **`inspectLock(file, { staleMs })`**（唯讀，不取得、不修改）：回 `{ state, pid, at, ageMs, staleMs, staleMsFrom:'holder'|'caller', alive, clockSkew, self }`，`state` 為 `none`（無鎖檔）、`corrupt`（壞檔或逾 2 秒寬限仍空）、`dead`（持鎖行程不存在，或為本行程 pid 之前世殘留）、`stale`（行程存活但逾陳舊期限）、`held`（行程存活且未逾期，含建立中之空檔）、`self`（本行程現持有）。時鐘回撥（鎖時刻在未來）時 `ageMs` 以 0 計並標 `clockSkew`。
- **訊息契約**：被占用時 `message` 前綴為「另一個執行中（pid X，已執行 Ns，陳舊期限 N 分（持鎖者宣告））」；`definePipeline` 以 `管道[name] 略過本輪：…` 轉印之，巡檢據字樣比對，不可改字。
- **已知限制**：①pid 重用：持鎖者崩潰而其 pid 被其他長命行程取得時，存活探測誤判為仍在跑，最壞阻擋至持鎖者宣告之期限（被擋之輪次於日誌記「略過本輪」）；②兩個取鎖者同時判定同一把陳舊鎖時，後刪者可能刪到先取得者剛建立之鎖（需崩潰殘留與毫秒級窗口同時發生）；③休眠喚醒後牆鐘前跳，存活之持鎖者可能被判陳舊；④鎖只涵蓋管線各段，`runPipeline` 回傳前即釋放，其後之執行摘要與收尾鉤子不在鎖內，`inspectLock` 回 `none` 不代表該行程已不再使用資料庫。

### 截止由排程上限推導
排程器之執行上限（如 Windows 工作排程器 `ExecutionTimeLimit`）是外部硬上限，撞到即被強制終止。整輪截止＝上限減安全邊際，上限與截止各專案只該有一份換算：

```alias
let limitMin = parseIsoDuration('PT20M') //ISO-8601 時距(只認 PT…H…M…S)，回分鐘數: PT1H30M → 90、PT90S → 1.5，寫錯即拋錯
let pl = definePipeline({ name: '抓取彙整', stages: [ /* ... */ ], deadlineMs: deadlineMsOf(limitMin) }) //20 分鐘 → 840000 毫秒
```

- `deadlineMsOf(limitMin, { marginMs, floorMs })` ＝ `max(floorMs, round(limitMin × 60000) − marginMs)`，一律取整（下游對非整數各自靜默失效）。`DEADLINE_MARGIN_MS` ＝ 360000（6 分，吸收排程端啟動延遲、子程序強殺保險與單次外部呼叫超出其逾時之量），`DEADLINE_FLOOR_MS` ＝ 600000（上限很短時寧可讓排程上限去截斷，不讓每段都因預算為負而不開工）；`limitMin` 須為非負有限數，否則拋錯；`opt` 非物件視為 `{}`，無效之 `marginMs`／`floorMs` 用預設。
- `parseIsoDuration` 時、分、秒三段皆認（只抓 `PT(\d+)M` 會把 `PT1H30M` 解成 30 分而讓截止靜默走偏）。

### 各段只經 budgetOf(ctx) 消費剩餘時間
截止由 `ctx` 持有（`remainingMs()`／`expired()`）。各段若各寫一份「ctx 有沒有這函數、回值是不是 true」之防禦判斷，寫法必然分歧，且取值時機易錯（工作流開工時取一次剩餘時間，序列後段席位拿到的是數十分鐘前的值）。故預算只有一個擁有者：各段呼叫 `budgetOf(ctx)`，不直接讀 `ctx.remainingMs`／`ctx.expired`。

```alias
run: async (ctx) => {
    let budget = budgetOf(ctx) //容錯 ctx 為 null／缺 remainingMs／缺 expired，皆不拋
    for (let it of items) {
        if (budget.shouldStop()) break //即 expired()
        await work(it, { timeoutMs: budget.capMs(60000) }) //以剩餘時間封頂，下限 1ms；無截止原樣回傳
    }
}
```

- `budgetOf(ctx)` 回 `{ expired, remainingMs, shouldStop, capMs, capSeat }`：`remainingMs()` 無截止回 `Infinity`、負值夾 0、非有限值視為無截止；`capMs(ms)` 以剩餘封頂（下限 1，`ms` 非正數視為無要求）。
- **`capSeat(seat)` 為何用 getter**：回傳席位物件之淺拷貝，並把 `budgetMs` 定義為 getter（可列舉）。工作流（如 w-dispatch-ai）於各席位**開工當下**才展開席位規格（`{...seat}`），getter 在那一刻求值，序列後段席位自然拿到當時之剩餘時間；若在工作流開工時就算成數字，後段席位拿到的是數十分鐘前的值，截止切不到它。無截止或 `seat` 非物件時原樣回傳。本函數只對席位物件做鴨子型別之淺拷貝，不 import w-dispatch-ai。
- `reserveOf(ctx, reserveMs)`：選配段之子預算，`remainingMs()` ＝ 整輪剩餘 − 保留（不得吃進後段之最低時間），`canStart(minMs)` ＝ 未逾期且剩餘 ≥ `minMs`，`shouldStop(minMs)` ＝ `!canStart`。
- `reserveMsOf(v, where)`：保留時間之正規化——未給為 `() => 0`；非負有限數 → 常數函數；函數 → 包一層檢查回傳；其餘拋錯，訊息帶 `where` 出處。

### 日誌之預設實作
```alias
let clock = genClockTZ('Asia/Taipei') //wsemi；本套件只呼叫 clock.stamp8() 與 clock.iso8
let lg = createLogger('run', { dir: './log', clock }) //建構即開檔 ./log/{day}/{stamp}-run.log；echo:false 可關 stdout
let pl = definePipeline({ name: '抓取彙整', stages: [ /* ... */ ], log: lg }) //具 info／warn／error 即可作 spec.log
// 日誌行: [2026-11-01T12:00:00+08:00] INFO  步驟1 collect 完成：…（0.3s）
```

- **格式即契約**：排程執行沒有 console，日誌是唯一的事後診斷來源，消費端之巡檢依此格式（檔名 `{day}/{stamp}-{name}.log`、行首 `[ISO 時間] 等級 訊息`、等級字面 `INFO `／`WARN `／`ERROR` 補成五字元對齊）解析逐輪統計——改動格式須連動其解析端。
- **每次執行獨立成檔**：排程與手動執行會交錯發生，混在同一檔內時，事後要看「某一次執行到底怎麼了」得先從時間戳挑行，而長步驟跨越數分鐘、兩次執行的行必然互相穿插；一次一檔可精準讀取該次完整歷程，「列出最近 N 次執行」也變成 `ls`。
- **open 與建立分離**：`createRunLogger({ root, getISO, echo })` 建立後須 `open(runId, day?, name?)` 才落檔（`{root}/{day||runId前8碼}/{runId}[-{name}].log`）；行程層級安全網（`uncaughtException`／`unhandledRejection`）須在最早期掛上，那時尚未決定 runId、也沒有檔案可寫，故 open 之前的訊息仍輸出 stdout 而不拋錯，open 之後才落檔。`createLogger(name, { dir, clock, echo })` 於建構期即知 stamp 與 name，故包一層立即 open；兩者共用同一份 write，另附 `now`（本次 stamp）、`elapsed()`（自建構以來秒數，一位小數）、`cliFail(r)`（`錯誤` ＋ 嘗試次數 ＋ stderr 前 300 字，委派 wsemi `execCliFailDetail`）。
- **寫檔失敗吞掉**：日誌是診斷手段而非業務目的，因磁碟滿或權限問題中斷整條管線是本末倒置。
- **同時輸出 stdout**：手動執行時可即時觀察進度，排程執行時無人接收、無副作用。
- **兩套方法名**：`log`／`logWarn`／`logError` 與 `info`／`warn`／`error`（同一函數）；`withTag(tag)` 回帶前綴之子記錄器（六個方法），前綴一致才能事後以 grep 逐步驟抽取。

## Installation

### Using npm(ES6 module):
```alias
npm i w-data-pipeline
```

#### Example
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-data-pipeline/blob/master/g.mjs)]
```alias
import w from 'wsemi'
import WOrm from 'w-orm-lmdb/src/WOrmLmdb.mjs' //ORM由外部注入(依賴注入), 將來可換相容WOrm實作
import WDataPipeline from './src/WDataPipeline.mjs'


let { definePipeline, runPipeline, defineFetcher, createFetcherRegistry, createSeenStore, runListFetch, runDetailFetch } = WDataPipeline


let test = async () => {
    let ms = []

    let fdDb = `./_test_pipeline_db`
    w.fsCleanFolder(fdDb)

    //pages, 模擬站台之內文頁, 實務上於defineFetcher之fetch內改用curl/原生fetch/playwright等實作抓取
    let pages = {
        'https://example.com/post/a': `文章A的內文, `.repeat(10),
        'https://example.com/post/b': `文章B的內文, `.repeat(10),
        'https://example.com/post/c': `文章C的內文, `.repeat(10),
    }

    //registry, 注入抓取器: list角色接來源回項目清單, detail角色接項目回內文, 「怎麼抓」完全由外部決定
    let registry = createFetcherRegistry([
        defineFetcher({
            id: 'sim-list',
            role: 'list',
            kinds: ['sim'],
            fetch: (src) => src.items, //模擬回傳清單
        }),
        defineFetcher({
            id: 'sim-detail',
            role: 'detail',
            match: () => true,
            fetch: (item) => ({ ok: true, text: pages[item.url] || '' }),
        }),
    ])

    //seen, 去重檢測器(LMDB): keyOf必填, 'raw'=sha1(自然鍵), 自然鍵預設取用順序 key → canonicalUrl → url
    let seen = createSeenStore({
        lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'docs' },
        keyOf: 'raw',
    })

    //pl, 管道: 外部給階段清單, 套件給秩序(逐段計時/失敗隔離/停止與收尾/時間預算)
    let pl = definePipeline({
        name: '抓取彙整',
        stages: [
            {
                name: 'collect',
                run: async (ctx) => {
                    let r = await runListFetch({
                        sources: ctx.deps.sources,
                        registry,
                        seen,
                        toRecord: (it) => ({ ...it, status: 'new' }), //入庫前補業務欄位
                    })
                    if (r.stats.fresh === 0) {
                        return { stop: true, reason: '本輪無新資料', fresh: [] } //提前收工, 後續段跳過
                    }
                    return { fresh: r.fresh, dup: r.stats.dup }
                },
            },
            {
                name: 'enrich',
                run: async (ctx) => {
                    let r = await runDetailFetch({
                        items: ctx.prev.fresh, //上一段回傳值
                        registry,
                        minTextChars: 10, //空殼頁防護
                    })
                    return { okCount: r.stats.ok, chars: r.stats.chars }
                },
            },
            {
                name: 'patrol',
                always: true, //收尾巡檢: 已停止/已中止仍執行
                run: async () => ({ count: await seen.count() }),
            },
        ],
    })

    //rounds, 三輪來源數據: 第1輪含批內重複(utm變體), 第2輪僅1篇為新, 第3輪全為已抓過
    let rounds = [
        [
            { url: 'https://example.com/post/a', title: '文章A' },
            { url: 'https://example.com/post/a?utm_source=news', title: '文章A(utm變體)' }, //batch內判重
            { url: 'https://example.com/post/b', title: '文章B' },
        ],
        [
            { url: 'https://example.com/post/b', title: '文章B' }, //已抓過
            { url: 'https://example.com/post/c', title: '文章C' }, //新
        ],
        [
            { url: 'https://example.com/post/a', title: '文章A' },
            { url: 'https://example.com/post/b', title: '文章B' },
            { url: 'https://example.com/post/c', title: '文章C' },
        ],
    ]
    for (let i = 0; i < rounds.length; i++) {
        let sources = [{ id: 'blog', name: '模擬部落格', kind: 'sim', items: rounds[i] }]
        let report = await runPipeline(pl, { deps: { sources } }) //頂層入口一律回傳report, 檢查report.ok即可
        let sts = report.stages
        ms.push({ [`round${i + 1}`]: `ok[${report.ok}], stopped[${report.stopped}], ` + sts.map((s) => `${s.name}[${s.status}]`).join(', ') })
        let fresh = sts[0].result?.fresh || []
        ms.push({ [`round${i + 1} 新增`]: fresh.map((it) => it.title).join(', ') || '(無)' })
        ms.push({ [`round${i + 1} 巡檢`]: `庫內共${sts[2].result.count}筆` })
    }

    //has, 鬆散查詢與正式項目走同一身分定義: 帶utm的網址查得到自己
    let b = await seen.has('https://example.com/post/a?utm_source=x')
    ms.push({ 'has utm變體': b })

    //clear
    await seen.close()
    w.fsDeleteFolder(fdDb)

    console.log('ms', ms)
    return ms
}
await test()
    .catch((err) => {
        console.log(err)
    })
// => ms [
//   {
//     round1: 'ok[true], stopped[false], collect[ok], enrich[ok], patrol[ok]'
//   },
//   { 'round1 新增': '文章A, 文章B' },
//   { 'round1 巡檢': '庫內共2筆' },
//   {
//     round2: 'ok[true], stopped[false], collect[ok], enrich[ok], patrol[ok]'
//   },
//   { 'round2 新增': '文章C' },
//   { 'round2 巡檢': '庫內共3筆' },
//   {
//     round3: 'ok[true], stopped[true], collect[ok], enrich[skip], patrol[ok]'
//   },
//   { 'round3 新增': '(無)' },
//   { 'round3 巡檢': '庫內共3筆' },
//   { 'has utm變體': true }
// ]
```
