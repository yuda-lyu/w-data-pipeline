import assert from 'assert'
import crypto from 'crypto'
import fs from 'fs'
import WOrm from 'w-orm-lmdb/src/WOrmLmdb.mjs' //ORM由外部注入(依賴注入), 見openCollection.mjs檔頭
import WDataPipeline from '../src/WDataPipeline.mjs'


let { keyStrategies, resolveKeyOf, createIdentity, defaultIdentityOf, createSeenStore, openCollection, normalizeUrl, ContractError } = WDataPipeline

//獨立參考實作: 以node crypto算sha1, 不用被測物驗被測物
let refSha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex')

//LMDB測試資料夾(mocha --parallel為逐檔分程序, 本檔專用資料夾不與他檔互撞)
let fdDb = './_test_wdp_dedup'


describe('identity-dedup', function() {

    describe('主鍵策略(keyOf)', function() {

        it('keyOf:raw 與 node crypto 之 sha1 逐類相同(ASCII/中文/網址/長字串)', function() {
            let cases = [
                'hello',
                '中文自然鍵測試',
                'https://example.com/post/1?utm_source=x',
                'x'.repeat(2000),
                'openalex:W2741809807',
            ]
            for (let s of cases) {
                assert.strictEqual(keyStrategies.raw(s), refSha1(s.trim()))
            }
        })

        it('keyOf:asis 原樣採用(僅trim), 不雜湊', function() {
            assert.strictEqual(keyStrategies.asis(' arxiv:2401.12345 '), 'arxiv:2401.12345')
        })

        it('keyOf:normalized 為 sha1(正規化後網址), 帶utm者與乾淨網址同鍵', function() {
            let clean = 'https://example.com/post/1'
            let dirty = 'https://example.com/post/1?utm_source=x&utm_medium=y'
            assert.strictEqual(keyStrategies.normalized(dirty), refSha1(clean))
            assert.strictEqual(keyStrategies.normalized(clean), keyStrategies.normalized(dirty))
        })

        it('keyOf:unwrapped 解轉址後算鍵(bing apiclick)', function() {
            let real = 'https://example.com/news/9'
            let wrapped = `https://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(real)}&tid=abc`
            assert.strictEqual(keyStrategies.unwrapped(wrapped), refSha1(real))
        })

        it('resolveKeyOf: 未知策略名或未指定拋 ContractError, 自訂函數原樣通過', function() {
            assert.throws(() => resolveKeyOf('md5'), ContractError)
            assert.throws(() => resolveKeyOf(undefined), ContractError) //keyOf無預設值, 必須明示
            let f = (k) => `k:${k}`
            assert.strictEqual(resolveKeyOf(f), f)
        })

    })

    describe('身分(identity)', function() {

        it('預設自然鍵取用順序 key → canonicalUrl → url, 空字串會落到下一順位', function() {
            assert.strictEqual(defaultIdentityOf({ key: 'K', canonicalUrl: 'C', url: 'U' }), 'K')
            assert.strictEqual(defaultIdentityOf({ key: '', canonicalUrl: 'C', url: 'U' }), 'C')
            //key與canonicalUrl皆空: url現算canonical(去utm)
            assert.strictEqual(
                defaultIdentityOf({ key: '', canonicalUrl: '', url: 'https://example.com/a?utm_source=x' }),
                'https://example.com/a',
            )
        })

        it('of() 具冪等性: 刻意不讀 item.id, 同一項目算幾次都同值', function() {
            let idt = createIdentity({ keyOf: 'raw' })
            let item = { url: 'https://example.com/a' }
            let id1 = idt.of(item)
            let id2 = idt.of({ ...item, id: id1 }) //把算出的id塞回去再算一次
            assert.strictEqual(id1, id2)
        })

        it('無自然鍵者回空字串, 不可硬算(避免共用同一雜湊鍵)', function() {
            let idt = createIdentity({ keyOf: 'raw' })
            assert.strictEqual(idt.of({}), '')
            assert.strictEqual(idt.of(null), '')
        })

        it('tai-news 型既有鍵: sha1(原始網址.trim()), 以獨立參考實作比對', function() {
            let idt = createIdentity({ keyOf: 'raw', identityOf: (it) => it.url })
            let url = 'https://example.com/news/1?utm_source=rss'
            //identityOf直取url: 不正規化, 帶utm者鍵不同於乾淨網址
            assert.strictEqual(idt.of({ url }), refSha1(url))
            assert.notStrictEqual(idt.of({ url }), refSha1('https://example.com/news/1'))
        })

        it('tai-kns-trade 型既有鍵: sha1(正規化後網址), 與 tai-news 型算出不同鍵', function() {
            let url = 'https://example.com/news/1?utm_source=rss'
            let idtKns = createIdentity({ keyOf: 'raw' }) //預設自然鍵即canonical
            let idtNews = createIdentity({ keyOf: 'raw', identityOf: (it) => it.url })
            assert.strictEqual(idtKns.of({ url }), refSha1('https://example.com/news/1'))
            assert.notStrictEqual(idtKns.of({ url }), idtNews.of({ url }))
        })

        it('自訂中間層: identityOf 組合欄位', function() {
            let idt = createIdentity({
                keyOf: 'asis',
                identityOf: (it) => `${it.extra.market}:${it.extra.symbol}:${it.time}`,
            })
            let item = { extra: { market: 'tw', symbol: '2330' }, time: '2020-01-01' }
            assert.strictEqual(idt.of(item), 'tw:2330:2020-01-01')
        })

        it('鬆散字串與正式項目走同一個 identityOf: 網址包成{url}, 其餘包成{key}', function() {
            let idt = createIdentity({ keyOf: 'raw' })
            //帶utm的鬆散網址查詢, 與乾淨網址項目算出同鍵
            assert.strictEqual(
                idt.of('https://example.com/a?utm_source=x'),
                idt.of({ url: 'https://example.com/a' }),
            )
            //非網址字串走key路徑(原樣採用後雜湊)
            assert.strictEqual(idt.of('openalex:W1'), refSha1('openalex:W1'))
        })

    })

    describe('去重檢測器(createSeenStore, LMDB)', function() {

        before(function() {
            fs.rmSync(fdDb, { recursive: true, force: true })
        })

        after(function() {
            fs.rmSync(fdDb, { recursive: true, force: true })
        })

        it('缺 collection 與 lmdb 拋 ContractError; openCollection 之 WOrm/path/db/cl 皆必填', function() {
            assert.throws(() => createSeenStore({ keyOf: 'raw' }), ContractError)
            assert.throws(() => openCollection({ path: fdDb, db: 'd', cl: 'c' }), ContractError) //缺WOrm(未注入ORM)
            assert.throws(() => openCollection({ WOrm, db: 'd', cl: 'c' }), ContractError)
            assert.throws(() => openCollection({ WOrm, path: fdDb, cl: 'c' }), ContractError)
            assert.throws(() => openCollection({ WOrm, path: fdDb, db: 'd' }), ContractError)
        })

        it('admit 跨輪去重: 第二輪同批全數判重, fresh保序且id由檢測器覆寫', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'admit' }, keyOf: 'raw' })
            try {
                let items = [
                    { url: 'https://example.com/a', title: 'A' },
                    { url: 'https://example.com/b', title: 'B' },
                ]
                let r1 = await seen.admit(items, { toRecord: (it) => ({ ...it, status: 'new', id: '亂給的id會被覆寫' }) })
                assert.strictEqual(r1.fresh.length, 2)
                assert.strictEqual(r1.dup, 0)
                //保序映射 + toRecord業務欄位 + id一律為主鍵
                assert.strictEqual(r1.fresh[0].title, 'A')
                assert.strictEqual(r1.fresh[0].status, 'new')
                assert.strictEqual(r1.fresh[0].id, refSha1('https://example.com/a'))

                let r2 = await seen.admit(items)
                assert.strictEqual(r2.fresh.length, 0)
                assert.strictEqual(r2.dup, 2)
            }
            finally {
                await seen.close()
            }
        })

        it('peek 只判斷不寫入(peek後再peek仍為fresh)', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'peek' }, keyOf: 'raw' })
            try {
                let items = [{ url: 'https://example.com/p1' }]
                let r1 = await seen.peek(items)
                assert.strictEqual(r1.fresh.length, 1)
                let r2 = await seen.peek(items)
                assert.strictEqual(r2.fresh.length, 1) //未占位
                await seen.admit(items)
                let r3 = await seen.peek(items)
                assert.strictEqual(r3.dup.length, 1)
            }
            finally {
                await seen.close()
            }
        })

        it('無自然鍵者不放行, 進 invalid 並帶原因', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'invalid' }, keyOf: 'raw' })
            try {
                let r = await seen.admit([{ title: '沒有key也沒有url' }, { url: 'https://example.com/ok' }])
                assert.strictEqual(r.fresh.length, 1)
                assert.strictEqual(r.invalid.length, 1)
                assert.ok(r.invalid[0].reason.includes('自然鍵'))
            }
            finally {
                await seen.close()
            }
        })

        it('has() 接受鬆散字串且走同一 identityOf: 帶utm的網址查得到自己', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'has' }, keyOf: 'raw' })
            try {
                await seen.admit([{ url: 'https://example.com/h1' }])
                assert.strictEqual(await seen.has('https://example.com/h1?utm_source=x'), true)
                assert.strictEqual(await seen.has('https://example.com/h2'), false)
                assert.strictEqual(await seen.has({ url: 'https://example.com/h1' }), true)
            }
            finally {
                await seen.close()
            }
        })

        it('併發 admit 同一項目: fresh 總和恰為 1(LMDB原子占位)', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'race' }, keyOf: 'raw' })
            try {
                let item = { url: 'https://example.com/race' }
                let rs = await Promise.all(Array.from({ length: 20 }, () => seen.admit([item])))
                let total = rs.reduce((a, r) => a + r.fresh.length, 0)
                assert.strictEqual(total, 1)
            }
            finally {
                await seen.close()
            }
        })

        it('mark 直接記為已見(黑名單場景)', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'mark' }, keyOf: 'raw' })
            try {
                assert.strictEqual(await seen.mark('https://example.com/bad'), true)
                assert.strictEqual(await seen.has('https://example.com/bad'), true)
                //再mark同一鍵: 已存在, 不再新增
                assert.strictEqual(await seen.mark('https://example.com/bad'), false)
            }
            finally {
                await seen.close()
            }
        })

        it('契約層與檢測層共用同一 identity: idOf 與 normalizeUrl 之canonical一致', async function() {
            let seen = createSeenStore({ lmdb: { WOrm, path: fdDb, db: 'wdp', cl: 'ident' }, keyOf: 'raw' })
            try {
                let url = 'https://example.com/i1?utm_source=x'
                assert.strictEqual(seen.idOf({ url }), refSha1(normalizeUrl(url)))
                assert.ok(seen.identity.describe().includes('keyOf=raw'))
            }
            finally {
                await seen.close()
            }
        })

    })

})
