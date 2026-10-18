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
