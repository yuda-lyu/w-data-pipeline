import assert from 'assert'
import fs from 'fs'
import WOrm from 'w-orm-lmdb/src/WOrmLmdb.mjs' //ORM由外部注入(依賴注入), 見openCollection.mjs檔頭
import WDataPipeline from '../src/WDataPipeline.mjs'


let { openCollection, ContractError } = WDataPipeline

//LMDB測試資料夾(測試臨時檔放test/_tmp/<案名>/, 由本檔before與after清除; mocha --parallel為逐檔分程序, 不與他檔互撞)
let fdDb = './test/_tmp/open-collection'

//每案專用集合名, 案與案之間不共用資料
let seq = 0
let nextCl = () => `c${++seq}`

//本檔開啟之集合, afterEach一律關閉(釋放LMDB檔案鎖)
let opened = []
let open = (cl, W = WOrm) => {
    let col = openCollection({ WOrm: W, path: fdDb, db: 'oc', cl })
    opened.push(col)
    return col
}

//替身WOrm工廠: 包真實w-orm-lmdb, 僅對指定cl之實例覆寫函數, 其餘實例(含自檢用實例)維持原樣, 不依賴被測物內部命名;
//over之各函數簽名為 (orig, ...args), orig為該實例原函數
let mkDouble = (target, over) => function(opt) {
    let real = WOrm(opt)
    if (opt.cl !== target) {
        return real
    }
    for (let [k, f] of Object.entries(over)) {
        let orig = real[k]
        real[k] = (...args) => f(orig, ...args)
    }
    return real
}

//不支援merge選項之替身WOrm(等同w-orm-lmdb 1.0.41之前或他後端): 所有實例之save皆忽略第二參數, 並記錄被呼叫之集合與主鍵
let mkNoMerge = (log) => function(opt) {
    let real = WOrm(opt)
    let save0 = real.save
    real.save = (data, option) => {
        log.push({ cl: opt.cl, ids: [].concat(data).map((v) => v.id), option })
        return save0(data) //忽略option
    }
    return real
}

//僅頂層支援merge:false之替身WOrm(頂層刪鍵與陣列替換正確, 但巢狀物件仍深合併): 所有實例之save皆如此
let mkNestedBlind = () => function(opt) {
    let real = WOrm(opt)
    let save0 = real.save
    real.save = async(data, option) => {
        if (option?.merge !== false) {
            return save0(data)
        }
        let out = []
        for (let v of [].concat(data)) {
            let old = await real.selectByPk(v.id)
            let nv = { ...v }
            if (old && old.nest && v.nest) {
                nv.nest = { ...old.nest, ...v.nest }
            }
            await real.del({ id: v.id })
            out.push(...await save0([nv]))
        }
        return out
    }
    return real
}

//deepStrictEqual之布林版
let isDeepEqual = (a, b) => {
    try {
        assert.deepStrictEqual(a, b)
        return true
    }
    catch {
        return false
    }
}

//取得rejection之錯誤物件; 未拋錯則本案失敗
let rejectOf = async(p) => {
    try {
        await p
    }
    catch (err) {
        return err
    }
    assert.fail('預期拋錯但未拋錯')
}

//[單筆失敗]之逐筆結果, 形狀同w-orm-lmdb之save與del
let failSave = async() => [{ n: 1, nInserted: 0, nModified: 0, ok: 0, err: 'boom-save' }]
let failDel = async() => [{ n: 1, nDeleted: 0, ok: 0, err: 'boom-del' }]

//w-orm-lmdb實際會回ok:0之輸入(Symbol無法序列化), 供不經替身之真實失敗路徑使用
let unwritable = () => ({ bad: Symbol('x') })


describe('open-collection', function() {

    before(function() {
        fs.rmSync(fdDb, { recursive: true, force: true })
    })

    afterEach(async function() {
        for (let col of opened) {
            await col.close()
        }
        opened = []
    })

    after(function() {
        fs.rmSync(fdDb, { recursive: true, force: true })
    })


    describe('R1 逐筆結果必檢查(fail-closed): ok:0拋錯, 訊息帶cl/id/err且不回顯記錄內容', function() {

        it('patch: 單筆失敗(替身回ok:0)拋錯, 訊息帶cl/id/err, 不含記錄內容', async function() {
            let cl = nextCl()
            let col = open(cl, mkDouble(cl, { save: failSave }))
            let e = await rejectOf(col.patch('p1', { secret: 'SECRET-PAYLOAD-42' }))
            assert.ok(e.message.includes(cl), e.message)
            assert.ok(e.message.includes('p1'), e.message)
            assert.ok(e.message.includes('boom-save'), e.message)
            assert.ok(!e.message.includes('SECRET-PAYLOAD-42'), e.message)
        })

        it('patch: 真實單筆失敗(無法序列化)拋錯, 原記錄不變', async function() {
            let col = open(nextCl())
            await col.insertNew([{ id: 'p2', v: 'keep' }])
            let e = await rejectOf(col.patch('p2', unwritable()))
            assert.ok(e.message.includes('p2'), e.message)
            assert.deepStrictEqual(await col.get('p2'), { id: 'p2', v: 'keep' })
        })

        it('replace: 單筆失敗(替身回ok:0)拋錯, 訊息帶cl/id/err, 不含記錄內容', async function() {
            let cl = nextCl()
            let col = open(cl, mkDouble(cl, { save: failSave }))
            let e = await rejectOf(col.replace({ id: 'r1', secret: 'SECRET-PAYLOAD-42' }))
            assert.ok(e.message.includes(cl), e.message)
            assert.ok(e.message.includes('r1'), e.message)
            assert.ok(e.message.includes('boom-save'), e.message)
            assert.ok(!e.message.includes('SECRET-PAYLOAD-42'), e.message)
        })

        it('replace: 逐筆結果缺漏(替身回空陣列)視為失敗, 不當成功', async function() {
            let cl = nextCl()
            let col = open(cl, mkDouble(cl, { save: async() => [] }))
            await rejectOf(col.replace({ id: 'r2', v: 1 }))
        })

        it('成功只認ok===1: ok為"0"、-1、{}、2等非1之值一律視為失敗(w-orm系列規定ok僅1與0)', async function() {
            for (let bad of ['0', -1, {}, 2]) {
                let cl = nextCl()
                let col = open(cl, mkDouble(cl, {
                    save: async() => [{ n: 1, nInserted: 0, nModified: 0, ok: bad }],
                    del: async() => [{ n: 1, nDeleted: 1, ok: bad }],
                }))
                await rejectOf(col.patch('s1', { a: 1 }))
                await rejectOf(col.replace({ id: 's1', a: 1 }))
                await rejectOf(col.del('s1'))
            }
        })

        it('del: 單筆失敗(替身回ok:0)拋錯, 訊息帶cl/id/err', async function() {
            let cl = nextCl()
            let col = open(cl, mkDouble(cl, { del: failDel }))
            let e = await rejectOf(col.del('d1'))
            assert.ok(e.message.includes(cl), e.message)
            assert.ok(e.message.includes('d1'), e.message)
            assert.ok(e.message.includes('boom-del'), e.message)
        })

        it('del: 整批reject(如已close)不被吞成false, 照實拋錯', async function() {
            let col = open(nextCl())
            await col.close()
            await rejectOf(col.del('d2'))
        })

        it('del: 無效id(空字串)由儲存層回ok:0, 照實拋錯, 不再回true', async function() {
            let col = open(nextCl())
            await rejectOf(col.del(''))
        })

        it('del: 回傳是否真的刪掉; 刪除不存在之id回false, 存在者回true且確實刪掉, 再刪回false', async function() {
            let col = open(nextCl())
            assert.strictEqual(await col.del('nope'), false)
            await col.insertNew([{ id: 'd3', v: 1 }])
            assert.strictEqual(await col.del('d3'), true)
            assert.strictEqual(await col.get('d3'), null)
            assert.strictEqual(await col.del('d3'), false)
        })

    })


    describe('R2 replace單一寫交易, 不經刪除', function() {

        it('replace不經del與insert: 兩者皆被注入拋錯時仍成功整筆覆寫', async function() {
            let cl = nextCl()
            let armed = false
            let boom = async(orig, ...args) => {
                if (armed) {
                    throw new Error('不應呼叫')
                }
                return orig(...args)
            }
            let col = open(cl, mkDouble(cl, { del: boom, insert: boom }))
            await col.insertNew([{ id: 'r3', a: 1, b: 2 }]) //種入經insert, 須在注入前
            armed = true
            await col.replace({ id: 'r3', a: 9 })
            assert.deepStrictEqual(await col.get('r3'), { id: 'r3', a: 9 })
        })

        it('寫入失敗(真實無法序列化)時原記錄仍在, 且拋錯(建議書附錄: 刪後插前失敗)', async function() {
            let col = open(nextCl())
            await col.insertNew([{ id: 'r4', v: 'keep-me' }])
            let e = await rejectOf(col.replace({ id: 'r4', ...unwritable() }))
            assert.deepStrictEqual(await col.get('r4'), { id: 'r4', v: 'keep-me' })
            assert.ok(e.message.includes('r4'), e.message)
        })

        it('刪後插前之空窗不存在: 不論del後是否有他者插入, 結果皆為本次寫入(建議書附錄: 併發)', async function() {
            let cl = nextCl()
            let fired = 0
            //del之後立即由他者插入同id(舊實作之空窗); 新實作不經del, 此鉤子不應被觸發
            let col = open(cl, mkDouble(cl, {
                del: async(orig, q) => {
                    fired++
                    let r = await orig(q)
                    await open(cl).raw.insert([{ id: 'r5', v: 'concurrent' }])
                    return r
                },
            }))
            await col.insertNew([{ id: 'r5', v: 'old' }])
            await col.replace({ id: 'r5', v: 'mine' })
            assert.deepStrictEqual(await col.get('r5'), { id: 'r5', v: 'mine' })
            assert.strictEqual(fired, 0)
        })

        it('正常刪鍵、巢狀物件與陣列整筆取代皆不殘留舊值', async function() {
            let col = open(nextCl())
            await col.insertNew([{ id: 'r6', a: 1, b: 2, arr: [1, 2, 3], nested: { x: 1, y: 2 } }])
            await col.replace({ id: 'r6', a: 9, arr: [7], nested: { x: 5 } })
            assert.deepStrictEqual(await col.get('r6'), { id: 'r6', a: 9, arr: [7], nested: { x: 5 } })
        })

        it('同一id多個replace併行(含首次自檢同時進行): 最終值恰為其中一筆完整記錄, 無跨記錄之鍵殘留', async function() {
            //包一層新的建構函數, 使其自檢尚未快取, 12個replace同時觸發首次自檢
            let col = open(nextCl(), (opt) => WOrm(opt))
            let recs = []
            for (let i = 0; i < 12; i++) {
                recs.push({ id: 'cc', [`only${i}`]: i, arr: new Array(i + 1).fill(i), nest: { [`k${i}`]: i } })
            }
            await Promise.all(recs.map((r) => col.replace(r)))
            let got = await col.get('cc')
            assert.ok(recs.some((r) => isDeepEqual(r, got)), JSON.stringify(got))
        })

        it('取代不存在之id等同插入; 取代後僅此一筆(自檢不污染真實集合)', async function() {
            let col = open(nextCl())
            await col.replace({ id: 'r7', v: 1 })
            assert.deepStrictEqual(await col.get('r7'), { id: 'r7', v: 1 })
            assert.strictEqual(await col.count(), 1)
        })

        it('取代缺id之記錄仍拋ContractError(成功路徑檢查不變)', async function() {
            let col = open(nextCl())
            await assert.rejects(col.replace({ v: 1 }), ContractError)
            await assert.rejects(col.replace({ id: '  ', v: 1 }), ContractError)
        })

    })


    describe('R3 replace須確認WOrm支援merge:false才寫入(不得靜默降級)', function() {

        it('不支援merge之替身WOrm: replace必拋錯(含w-orm-lmdb >= 1.0.41), 資料不被誤改, 真實集合未收到任何save', async function() {
            let log = []
            let cl = nextCl()
            let col = open(cl, mkNoMerge(log))
            await col.insertNew([{ id: 'm1', a: 1, b: 2, arr: [1, 2, 3] }])
            let e = await rejectOf(col.replace({ id: 'm1', a: 9, arr: [7] }))
            assert.ok(e instanceof ContractError, String(e))
            assert.ok(e.message.includes('w-orm-lmdb >= 1.0.41'), e.message)
            assert.deepStrictEqual(await col.get('m1'), { id: 'm1', a: 1, b: 2, arr: [1, 2, 3] })
            assert.deepStrictEqual(log.filter((x) => x.cl === cl), [])
        })

        it('不支援merge之判定為終態: 同一WOrm再次replace仍拋錯, 資料仍不變', async function() {
            let log = []
            let cl = nextCl()
            let col = open(cl, mkNoMerge(log))
            await col.insertNew([{ id: 'm2', a: 1, b: 2 }])
            await rejectOf(col.replace({ id: 'm2', a: 9 }))
            let nOthers = log.filter((x) => x.cl !== cl).length
            assert.ok(nOthers > 0, '首次replace應有自檢')
            let e = await rejectOf(col.replace({ id: 'm2', a: 10 }))
            assert.ok(e.message.includes('w-orm-lmdb >= 1.0.41'), e.message)
            assert.deepStrictEqual(await col.get('m2'), { id: 'm2', a: 1, b: 2 })
            assert.strictEqual(log.filter((x) => x.cl !== cl).length, nOthers) //終態已快取, 不再重新自檢
        })

        it('僅頂層支援merge:false之WOrm(巢狀物件仍深合併)亦判不支援: 拋ContractError, 資料不變', async function() {
            let col = open(nextCl(), mkNestedBlind())
            await col.insertNew([{ id: 'n1', keep: 1, nest: { a: 1, b: 1 } }])
            let e = await rejectOf(col.replace({ id: 'n1', keep: 2, nest: { a: 2 } }))
            assert.ok(e instanceof ContractError, String(e))
            assert.deepStrictEqual(await col.get('n1'), { id: 'n1', keep: 1, nest: { a: 1, b: 1 } })
        })

        it('自檢讀回異常(查無探針記錄)屬無法判定: 拋一般Error而非ContractError、不快取、資料不變, 恢復後可成功', async function() {
            let st = { n: 0, anomaly: true }
            let W = (opt) => {
                st.n++
                let real = WOrm(opt)
                if (st.n > 1) {
                    let sel0 = real.selectByPk
                    real.selectByPk = async(id) => (st.anomaly ? null : sel0(id))
                }
                return real
            }
            let col = open(nextCl(), W)
            await col.insertNew([{ id: 'a1', a: 1, b: 2 }])
            let e = await rejectOf(col.replace({ id: 'a1', a: 9 }))
            assert.ok(!(e instanceof ContractError), String(e))
            assert.deepStrictEqual(await col.get('a1'), { id: 'a1', a: 1, b: 2 })
            st.anomaly = false
            await col.replace({ id: 'a1', a: 9 })
            assert.deepStrictEqual(await col.get('a1'), { id: 'a1', a: 9 })
        })

        it('不支援merge者不影響patch與del(兩者不需merge:false)', async function() {
            let log = []
            let col = open(nextCl(), mkNoMerge(log))
            await col.insertNew([{ id: 'm3', a: 1 }])
            await col.patch('m3', { b: 2 })
            assert.deepStrictEqual(await col.get('m3'), { id: 'm3', a: 1, b: 2 })
            assert.strictEqual(await col.del('m3'), true)
        })

        it('自檢為一次性: 同一WOrm建構函數僅首次replace建立額外實例, 其後(含其他集合)不再自檢', async function() {
            let st = { n: 0 }
            let W = (opt) => {
                st.n++
                return WOrm(opt)
            }
            let col1 = open(nextCl(), W)
            let n0 = st.n
            await col1.replace({ id: 's1', v: 1 })
            let n1 = st.n
            assert.ok(n1 > n0, '首次replace應有自檢')
            await col1.replace({ id: 's1', v: 2 })
            assert.strictEqual(st.n, n1)
            let col2 = open(nextCl(), W)
            let n2 = st.n
            await col2.replace({ id: 's2', v: 1 })
            assert.strictEqual(st.n, n2)
        })

        it('探針集合名為保留名: 業務集合不可取用, 以免探針記錄混入業務集合', function() {
            assert.throws(() => openCollection({ WOrm, path: fdDb, db: 'oc', cl: '__wdp_probe__' }), ContractError)
        })

        it('自檢本身失敗(無法建立自檢用實例)亦fail-closed: 拋錯、資料不變, 且不快取失敗(恢復後可成功)', async function() {
            let st = { n: 0, boom: true }
            let W = (opt) => {
                st.n++
                if (st.n > 1 && st.boom) {
                    throw new Error('probe-boom')
                }
                return WOrm(opt)
            }
            let col = open(nextCl(), W)
            await col.insertNew([{ id: 'f1', a: 1, b: 2 }])
            let e = await rejectOf(col.replace({ id: 'f1', a: 9 }))
            assert.ok(e.message.includes('probe-boom'), e.message)
            assert.deepStrictEqual(await col.get('f1'), { id: 'f1', a: 1, b: 2 })
            st.boom = false
            await col.replace({ id: 'f1', a: 9 })
            assert.deepStrictEqual(await col.get('f1'), { id: 'f1', a: 9 })
        })

    })


    describe('成功路徑行為鎖定(本次修改前後不變)', function() {

        it('patch: 深合併保留未給之欄位, 回傳undefined', async function() {
            let col = open(nextCl())
            await col.insertNew([{ id: 'k1', a: 1, nested: { x: 1 } }])
            let r = await col.patch('k1', { nested: { y: 2 }, b: 3 })
            assert.strictEqual(r, undefined)
            assert.deepStrictEqual(await col.get('k1'), { id: 'k1', a: 1, nested: { x: 1, y: 2 }, b: 3 })
        })

        it('patch: 不存在之id依w-orm-lmdb預設自動插入; 缺id拋ContractError', async function() {
            let col = open(nextCl())
            await col.patch('k2', { a: 1 })
            assert.deepStrictEqual(await col.get('k2'), { id: 'k2', a: 1 })
            await assert.rejects(col.patch('  ', { a: 1 }), ContractError)
        })

        it('replace: 成功回傳undefined', async function() {
            let col = open(nextCl())
            await col.insertNew([{ id: 'k3', a: 1 }])
            assert.strictEqual(await col.replace({ id: 'k3', a: 2 }), undefined)
        })

        it('insertNew: 去重回傳實際新增者', async function() {
            let col = open(nextCl())
            let r1 = await col.insertNew([{ id: 'k4', v: 1 }, { id: 'k5', v: 1 }])
            assert.strictEqual(r1.addCount, 2)
            let r2 = await col.insertNew([{ id: 'k4', v: 2 }, { id: 'k6', v: 1 }])
            assert.deepStrictEqual(r2.added.map((v) => v.id), ['k6'])
            assert.strictEqual(r2.dupCount, 1)
            assert.deepStrictEqual(await col.get('k4'), { id: 'k4', v: 1 })
        })

    })

})
