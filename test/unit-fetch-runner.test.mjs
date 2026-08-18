import assert from 'assert'
import fs from 'fs'
import WOrm from 'w-orm-lmdb/src/WOrmLmdb.mjs' //ORM由外部注入(依賴注入), 見openCollection.mjs檔頭
import WDataPipeline from '../src/WDataPipeline.mjs'


let { defineFetcher, createFetcherRegistry, runListFetch, runDetailFetch, createSeenStore, normalizeItems, normalizeContent, ContractError } = WDataPipeline

//delay
let delay = (ms) => new Promise((r) => setTimeout(r, ms))

//LMDB測試資料夾(mocha --parallel為逐檔分程序, 本檔專用資料夾不與他檔互撞)
let fdDb = './_test_wdp_fetch'


describe('fetch-runner', function() {

    describe('抓取器宣告(defineFetcher)', function() {

        it('缺 id/缺 fetch/role 打錯字/timeoutMs 非整數皆拋 ContractError', function() {
            assert.throws(() => defineFetcher({ fetch: () => [] }), ContractError)
            assert.throws(() => defineFetcher({ id: 'a' }), ContractError)
            assert.throws(() => defineFetcher({ id: 'a', role: 'lists', fetch: () => [] }), ContractError)
            assert.throws(() => defineFetcher({ id: 'a', fetch: () => [], timeoutMs: 1.5 }), ContractError)
        })

    })

    describe('登錄簿(createFetcherRegistry)', function() {

        it('id 重複拋 ContractError', function() {
            assert.throws(() => createFetcherRegistry([
                { id: 'a', fetch: () => [] },
                { id: 'a', fetch: () => [] },
            ]), ContractError)
        })

        it('解析順序: 指名 → kinds → match; 皆不中回 null', function() {
            let reg = createFetcherRegistry([
                { id: 'byKind', role: 'list', kinds: ['rss'], fetch: () => [] },
                { id: 'byMatch', role: 'list', match: (t) => t.kind === 'special', fetch: () => [] },
            ])
            assert.strictEqual(reg.resolve('list', { kind: 'rss' }).id, 'byKind')
            assert.strictEqual(reg.resolve('list', { kind: 'special' }).id, 'byMatch')
            assert.strictEqual(reg.resolve('list', { fetcher: 'byMatch', kind: 'rss' }).id, 'byMatch') //指名覆蓋kind
            assert.strictEqual(reg.resolve('list', { kind: 'unknown' }), null)
        })

        it('指名了未註冊的抓取器一律拋錯, 不默默改用別的', function() {
            let reg = createFetcherRegistry([{ id: 'a', role: 'list', fetch: () => [] }])
            assert.throws(() => reg.resolve('list', { fetcher: 'ghost' }), ContractError)
        })

        it('指名的抓取器 role 不符拋錯', function() {
            let reg = createFetcherRegistry([{ id: 'a', role: 'list', fetch: () => [] }])
            assert.throws(() => reg.resolve('detail', { fetcher: 'a' }), ContractError)
        })

    })

    describe('契約層(normalizeItems/normalizeContent)', function() {

        it('回傳非陣列拋 TypeError(抓取器實作錯誤, 不當成沒抓到)', function() {
            assert.throws(() => normalizeItems(null, {}), TypeError)
            assert.throws(() => normalizeItems({ items: [] }, {}), TypeError)
        })

        it('逐項判定: 壞項目進 invalid 不整批拒絕; 批內去重計入 dupInBatch', function() {
            let { items, invalid, dupInBatch } = normalizeItems([
                { url: 'https://example.com/a', title: 'A' },
                { url: 'https://example.com/a?utm_source=x', title: 'A2' }, //canonical後與上重複
                { title: '沒有key與url' },
                { url: 'ftp://example.com/x' }, //非http(s)
                { url: 'https://example.com/b' },
            ], {})
            //未給identity時批內去重鍵為 key→canonicalUrl→url, utm變體canonical後判重
            assert.strictEqual(items.length, 2)
            assert.strictEqual(dupInBatch, 1)
            assert.strictEqual(invalid.length, 2)
        })

        it('路由欄位 kind/fetcher 原樣保留; time 留字串原樣', function() {
            let { items } = normalizeItems([
                { url: 'https://example.com/a', kind: 'hard', fetcher: 'camoufox', pubDate: 'Wed, 01 Jan 2020 00:00:00 GMT' },
            ], {})
            assert.strictEqual(items[0].kind, 'hard')
            assert.strictEqual(items[0].fetcher, 'camoufox')
            assert.strictEqual(items[0].time, 'Wed, 01 Jan 2020 00:00:00 GMT')
        })

        it('normalizeContent: 兩種成功形狀 {ok,text} 與 {status:success,content}', function() {
            let a = normalizeContent({ ok: true, text: '正文'.repeat(10) }, {})
            assert.strictEqual(a.ok, true)
            let b = normalizeContent({ status: 'success', content: '正文'.repeat(10) }, {})
            assert.strictEqual(b.ok, true)
            assert.strictEqual(b.text, '正文'.repeat(10))
        })

        it('normalizeContent: 空手而回判 too-short(minTextChars 未給時門檻為 1)', function() {
            let r = normalizeContent({ ok: true, text: '' }, {})
            assert.strictEqual(r.ok, false)
            assert.strictEqual(r.reason, 'too-short')
        })

        it('normalizeContent: links 一對多產物(正文可空), 壞連結靜默剔除', function() {
            let r = normalizeContent({
                ok: true,
                text: '',
                links: [
                    { url: 'https://example.com/x', text: '好連結' },
                    { url: 'mailto:a@b.c', text: '壞連結' },
                    { url: '', text: '空連結' },
                ],
            }, {})
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.links.length, 1)
            assert.strictEqual(r.links[0].url, 'https://example.com/x')
        })

        it('normalizeContent: 失敗路徑保留 extra(診斷資訊)', function() {
            let r = normalizeContent({ ok: false, reason: 'blocked', extra: { httpStatus: 403 } }, {})
            assert.strictEqual(r.ok, false)
            assert.strictEqual(r.extra.httpStatus, 403)
        })

    })

    describe('輪抓來源(runListFetch)', function() {

        before(function() {
            fs.rmSync(fdDb, { recursive: true, force: true })
        })

        after(function() {
            fs.rmSync(fdDb, { recursive: true, force: true })
        })

        it('抓取 → 契約檢查 → 去重占位: 跨兩輪只放行新項目', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'list' }, keyOf: 'raw' })
            try {
                let registry = createFetcherRegistry([
                    { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => src.items },
                ])
                let sources1 = [{ id: 's1', name: '模擬源', kind: 'sim', items: [
                    { url: 'https://example.com/1', title: 'T1' },
                    { url: 'https://example.com/2', title: 'T2' },
                ] }]
                let r1 = await runListFetch({ sources: sources1, registry, seen, toRecord: (it) => ({ ...it, status: 'new' }) })
                assert.strictEqual(r1.stats.fresh, 2)
                assert.strictEqual(r1.fresh[0].status, 'new')
                assert.ok(r1.fresh[0].id) //已含主鍵

                let sources2 = [{ id: 's1', name: '模擬源', kind: 'sim', items: [
                    { url: 'https://example.com/2', title: 'T2' }, //已抓過
                    { url: 'https://example.com/3', title: 'T3' }, //新
                ] }]
                let r2 = await runListFetch({ sources: sources2, registry, seen })
                assert.strictEqual(r2.stats.fresh, 1)
                assert.strictEqual(r2.stats.dup, 1)
            }
            finally {
                await seen.close()
            }
        })

        it('單一來源失敗只跳過該來源, 其他來源照常', async function() {
            let registry = createFetcherRegistry([
                { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => {
                    if (src.bad) throw new Error('站台掛了')
                    return src.items
                } },
            ])
            let sources = [
                { id: 'bad', kind: 'sim', bad: true },
                { id: 'good', kind: 'sim', items: [{ url: 'https://example.com/ok' }] },
            ]
            let r = await runListFetch({ sources, registry })
            assert.strictEqual(r.stats.failed, 1)
            assert.strictEqual(r.stats.ok, 1)
            assert.strictEqual(r.results[0].reason, 'fetch-error')
            assert.strictEqual(r.results[1].items.length, 1)
        })

        it('strictUnhandled 預設: 有來源無抓取器 → 開工前整批拋 ContractError(任何來源都不開抓)', async function() {
            let fetched = false
            let registry = createFetcherRegistry([
                { id: 'sim', role: 'list', kinds: ['sim'], fetch: () => { fetched = true; return [] } },
            ])
            let sources = [
                { id: 'ok', kind: 'sim', items: [] },
                { id: 'nobody', kind: 'unknown' },
            ]
            await assert.rejects(async () => runListFetch({ sources, registry }), ContractError)
            assert.strictEqual(fetched, false) //設定錯誤 fail loud, 不是跑到一半才發現
        })

        it('strictUnhandled:false 才改為記該來源失敗並續跑其他來源', async function() {
            let registry = createFetcherRegistry([
                { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => src.items },
            ])
            let sources = [
                { id: 'nobody', kind: 'unknown' },
                { id: 'ok', kind: 'sim', items: [{ url: 'https://example.com/s' }] },
            ]
            let r = await runListFetch({ sources, registry, strictUnhandled: false })
            assert.strictEqual(r.results[0].reason, 'no-fetcher')
            assert.strictEqual(r.results[1].ok, true)
        })

        it('filter 業務過濾於 admit 前生效: 被剔除者不入庫, 政策放寬後仍進得來', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'filter' }, keyOf: 'raw' })
            try {
                let registry = createFetcherRegistry([
                    { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => src.items },
                ])
                let sources = [{ id: 's1', kind: 'sim', items: [
                    { url: 'https://example.com/keep' },
                    { url: 'https://example.com/drop' },
                ] }]
                let r1 = await runListFetch({
                    sources, registry, seen,
                    filter: (items) => items.filter((it) => !it.url.includes('drop')),
                })
                assert.strictEqual(r1.stats.filtered, 1)
                assert.strictEqual(r1.stats.fresh, 1)
                //政策放寬(不再過濾): 先前被剔除者未被占位, 仍可入庫
                let r2 = await runListFetch({ sources, registry, seen })
                assert.strictEqual(r2.stats.fresh, 1)
                assert.strictEqual(r2.fresh[0].url, 'https://example.com/drop')
            }
            finally {
                await seen.close()
            }
        })

        it('filter 回傳非陣列屬呼叫端實作錯誤, 該來源記 throw 不靜默吞掉', async function() {
            let registry = createFetcherRegistry([
                { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => src.items },
            ])
            let r = await runListFetch({
                sources: [{ id: 's1', kind: 'sim', items: [{ url: 'https://example.com/x' }] }],
                registry,
                filter: () => null,
            })
            assert.strictEqual(r.results[0].reason, 'throw')
            assert.ok(r.results[0].message.includes('filter'))
        })

        it('onSource 非同步回調於 runner 返回前必已完成', async function() {
            let calls = []
            let registry = createFetcherRegistry([
                { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => src.items },
            ])
            await runListFetch({
                sources: [{ id: 's1', kind: 'sim', items: [] }],
                registry,
                onSource: async (r) => {
                    await delay(20)
                    calls.push(r.source.id)
                },
            })
            assert.deepStrictEqual(calls, ['s1'])
        })

        it('onSource 回調拋錯不影響結果, 且記於 settledError 呈報', async function() {
            let registry = createFetcherRegistry([
                { id: 'sim', role: 'list', kinds: ['sim'], fetch: (src) => src.items },
            ])
            let r = await runListFetch({
                sources: [{ id: 's1', kind: 'sim', items: [{ url: 'https://example.com/x' }] }],
                registry,
                onSource: () => { throw new Error('統計寫入失敗') },
            })
            assert.strictEqual(r.results[0].ok, true) //回調失敗不改判來源成敗
            assert.strictEqual(r.stats.fresh, 1)
        })

    })

    describe('補抓內文(runDetailFetch)', function() {

        it('item.kind 路由優先於 match; 兩種成功形狀皆可', async function() {
            let registry = createFetcherRegistry([
                { id: 'camoufox', role: 'detail', kinds: ['hard'], fetch: () => ({ status: 'success', content: 'C'.repeat(100) }) },
                { id: 'curl', role: 'detail', match: () => true, fetch: () => ({ ok: true, text: 'T'.repeat(100) }) },
            ])
            let r = await runDetailFetch({
                items: [
                    { url: 'https://example.com/hard', kind: 'hard' },
                    { url: 'https://example.com/easy' },
                ],
                registry,
            })
            assert.strictEqual(r.results[0].fetcherId, 'camoufox')
            assert.strictEqual(r.results[1].fetcherId, 'curl')
            assert.strictEqual(r.stats.ok, 2)
        })

        it('正文低於 minTextChars 判 too-short(抓取器 contract 優先於全域)', async function() {
            let registry = createFetcherRegistry([
                { id: 'curl', role: 'detail', match: () => true, contract: { minTextChars: 300 }, fetch: () => ({ ok: true, text: 'x'.repeat(100) }) },
            ])
            let r = await runDetailFetch({ items: [{ url: 'https://example.com/thin' }], registry, minTextChars: 10 })
            assert.strictEqual(r.results[0].ok, false)
            assert.strictEqual(r.results[0].reason, 'too-short')
        })

        it('links 產物: 正文可空, 統計計入 links', async function() {
            let registry = createFetcherRegistry([
                { id: 'curl', role: 'detail', match: () => true, fetch: () => ({
                    ok: true,
                    text: '',
                    links: [{ url: 'https://example.com/l1', text: 'L1' }, { url: 'javascript:void(0)' }],
                }) },
            ])
            let r = await runDetailFetch({ items: [{ url: 'https://example.com/digest' }], registry })
            assert.strictEqual(r.results[0].ok, true)
            assert.strictEqual(r.stats.links, 1)
        })

        it('逾時判 timeout, 且該次嘗試之 AbortSignal 已被觸發(合作式取消)', async function() {
            let aborted = false
            let registry = createFetcherRegistry([
                { id: 'slow', role: 'detail', match: () => true, timeoutMs: 30, fetch: (item, ctx, { signal }) => new Promise(() => {
                    signal.addEventListener('abort', () => { aborted = true })
                }) },
            ])
            let r = await runDetailFetch({ items: [{ url: 'https://example.com/slow' }], registry })
            assert.strictEqual(r.results[0].ok, false)
            assert.strictEqual(r.results[0].reason, 'timeout')
            assert.strictEqual(aborted, true)
        })

        it('retries: 首次失敗後重試成功, attempt 序號遞增', async function() {
            let attempts = []
            let registry = createFetcherRegistry([
                { id: 'flaky', role: 'detail', match: () => true, retries: 1, fetch: (item, ctx, { attempt }) => {
                    attempts.push(attempt)
                    if (attempt === 0) throw new Error('first fail')
                    return { ok: true, text: 'y'.repeat(50) }
                } },
            ])
            let r = await runDetailFetch({ items: [{ url: 'https://example.com/flaky' }], registry })
            assert.deepStrictEqual(attempts, [0, 1])
            assert.strictEqual(r.results[0].ok, true)
        })

        it('strictUnhandled 預設: 有項目無抓取器 → 開工前整批拋 ContractError', async function() {
            let registry = createFetcherRegistry([
                { id: 'onlyHard', role: 'detail', kinds: ['hard'], fetch: () => ({ ok: true, text: 'z'.repeat(50) }) },
            ])
            await assert.rejects(async () => runDetailFetch({
                items: [{ url: 'https://example.com/none', kind: 'soft' }],
                registry,
            }), ContractError)
        })

    })

})
