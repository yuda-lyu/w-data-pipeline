import { ContractError } from '../core/errors.mjs'

/** LMDB key 的安全上限（lmdb-js 預設 maxKeySize 1978 bytes，取保守值） */
const MAX_KEY_BYTES = 1000

/** replace 所需之 WOrm 最低相容需求（save 之 option.merge:false 整筆覆寫） */
const MERGE_FALSE_NEED = 'w-orm-lmdb >= 1.0.41'

/** 自檢用探針集合名（保留名，openCollection 拒收）：置於與業務集合相同之 path／db 下，僅暫存自檢記錄、用畢盡力清除，與業務集合隔離 */
const PROBE_CL = '__wdp_probe__'

function assertId(id, where) {
    const s = String(id ?? '').trim()
    if (s === '') throw new ContractError(`${where}：記錄缺少非空字串 id（會被指派隨機 id 而永遠無法去重）`)
    if (Buffer.byteLength(s, 'utf8') > MAX_KEY_BYTES) throw new ContractError(`${where}：id 超過 ${MAX_KEY_BYTES} bytes，請改用雜湊`)
    return s
}

/**
 * 檢查 WOrm 寫入函數之逐筆結果，失敗即拋錯（fail-closed）。
 *
 * w-orm-lmdb 對單筆失敗不 reject，而以 { ok:0, err } 回報並註明「由呼叫端逐筆檢查」；
 * 本層即是該呼叫端。w-orm 系列規定 ok 僅有 1（成功）與 0（該筆失敗）兩值，故只認 ok === 1；
 * 結果缺漏或 ok 為其他任何值一律視為失敗——無法確認成功就不當成功。
 * 訊息帶 cl、id 與 err；本層不會把記錄內容放進訊息，但 err 為儲存層原文，原樣轉出
 * （儲存層之編碼錯誤可能引述有問題的欄位值，本層無從過濾）。
 */
function assertSaved(item, op, cl, id) {
    if (item && item.ok === 1) return item
    const err = item ? (item.err ?? `ok 非 1（${String(item.ok)}）`) : '逐筆結果缺漏'
    throw new Error(`${op} 寫入失敗（cl=${cl}，id=${id}）：${err}`)
}

/**
 * 實測注入之 WOrm 是否支援 save 之 option.merge:false（整筆覆寫）。
 *
 * 【為何要實測】merge 為 w-orm-lmdb >= 1.0.41 才有之選項。舊版或他後端會忽略它而當成深合併，
 * 舊鍵殘留且無任何錯誤，replace 因而靜默降級為 patch。WOrm 由呼叫端注入，本層無法由版本號判斷，
 * 只能看行為：在隔離之探針集合先存 {keep,drop,arr:[1,2,3],nest:{a:1,b:1}}，再以 merge:false 存
 * {keep,arr:[9],nest:{a:2}}，讀回須恰為後者（drop 消失、陣列整筆替換、巢狀物件之 b 消失）。
 * 探針只動自己的暫存記錄，不碰業務集合任何一筆。
 *
 * 【判定分兩種，處置不同】讀回之記錄存在且 id 相符，而內容不符 → 確定為「不支援」（回 false，終態）；
 * 讀不到探針或 id 不符 → 無法判定（拋錯，視為自檢未完成，不快取、下次重試）。
 *
 * 【前提：支援度是 WOrm 建構函數之性質】同一建構函數對任何 path／db／cl 行為一致。探針用固定之
 * path／db 與保留 cl 名；若傳入的是會依 cl／path／db 分派到不同後端（或不同版本）的工廠，
 * 探針結果不能代表業務集合，不在支援範圍。
 *
 * 【清理為盡力而為，刻意不套 R1】探針記錄清不掉或關閉失敗只會殘留在保留集合（不影響業務集合，
 * 下次自檢用新 id），故不因清理失敗而推翻已得之判定；reject 的主錯誤也不被清理錯誤掩蓋。
 */
async function probeMergeFalse(WOrm, path, db) {
    const pw = WOrm({ url: path, db, cl: PROBE_CL, autoGenPk: false })
    const id = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    try {
        assertSaved((await pw.save([{ id, keep: 1, drop: 1, arr: [1, 2, 3], nest: { a: 1, b: 1 } }]))?.[0], '自檢種入', PROBE_CL, id)
        assertSaved((await pw.save([{ id, keep: 2, arr: [9], nest: { a: 2 } }], { merge: false }))?.[0], '自檢覆寫', PROBE_CL, id)
        const got = await pw.selectByPk(id)
        if (!got || got.id !== id) throw new Error('自檢讀回異常（查無探針記錄或 id 不符），無法判定')
        return Object.keys(got).sort().join() === 'arr,id,keep,nest' && got.keep === 2 &&
            JSON.stringify(got.arr) === '[9]' && JSON.stringify(got.nest) === '{"a":2}'
    }
    finally {
        try {
            await pw.del({ id })
        }
        catch { /* 暫存記錄清不掉不影響判定；下次自檢用新 id，不互相干擾 */ }
        try {
            await pw.close()
        }
        catch { /* 關閉失敗不影響判定 */ }
    }
}

/** WOrm 建構函數 → 自檢結果 Promise<boolean>（支援度為建構函數之性質，每個建構函數只自檢一次） */
const mergeFalseVerdicts = new WeakMap()

/**
 * 確認 WOrm 支援 merge:false，否則拋錯（fail-closed，且發生於對業務集合寫入之前，資料不被誤改）。
 * 判定為「不支援」屬終態並快取；自檢本身失敗或無法判定（見 probeMergeFalse）不快取，下次呼叫重試，同樣拋錯。
 */
async function assertMergeFalse(WOrm, path, db) {
    let p = mergeFalseVerdicts.get(WOrm)
    if (!p) {
        p = probeMergeFalse(WOrm, path, db)
        mergeFalseVerdicts.set(WOrm, p)
        p.catch(() => {
            if (mergeFalseVerdicts.get(WOrm) === p) mergeFalseVerdicts.delete(WOrm)
        })
    }
    let supported
    try {
        supported = await p
    }
    catch (err) {
        throw new Error(`replace 無法確認 WOrm 是否支援 merge:false（自檢失敗：${err?.message || err}）；replace 需要 ${MERGE_FALSE_NEED}，未確認前不寫入`)
    }
    if (!supported) throw new ContractError(`replace 需要支援 save 之 merge:false（整筆覆寫）的 WOrm（${MERGE_FALSE_NEED}）；注入之 WOrm 將其當成深合併，舊鍵會殘留，故拒絕寫入`)
}

/**
 * 開啟一個集合（去重檢測器的儲存底座）。用完務必 close()。
 *
 * 【WOrm 由外部注入（依賴注入）】本檔不 import 任何 ORM——建構函數由呼叫端以
 * opt.WOrm 傳入，套件本體因此零儲存層相依，將來可換成相容實作。注入之 WOrm 須為
 * w-orm-lmdb 1.0.20+ 之介面：WOrm({url, db, cl, autoGenPk}) 回傳
 * { select, selectByPk, insert, save, del, close }，且須具備：
 * ①selectByPk 主鍵直讀（O(1)，不經全表掃描）；
 * ②insert 之原子條件寫入（以 lmdb-js 之 ifNoExists 於同一寫交易內完成
 * 「檢查未存在」與「寫入」，無競態空窗——併發插入同一 id 僅一次成功）；
 * ③insert 之 returnList:true 逐筆結果；④autoGenPk:false 拒收無 id 記錄；
 * ⑤close() 後各函數立即 reject（若 close 後靜默回「查無資料」，去重會 fail-open
 * 把每筆都判為新資料而整批重送下游）；⑥save／del 以逐筆結果 { ok, err } 回報單筆失敗而不 reject
 * （本層逐筆檢查，ok:0 即拋錯）；⑦若要用 replace：save 須支援 option.merge:false
 * （同一寫交易內整筆覆寫），即 **w-orm-lmdb >= 1.0.41**（相容需求，見 replace 說明；
 * 舊版或他後端會忽略該選項而靜默降級為深合併，故 replace 首次呼叫時自檢，不支援即拒絕寫入）。
 * 注入時建議走 'w-orm-lmdb/src/WOrmLmdb.mjs'（原生 ESM）而非套件主入口
 * （主入口是 UMD bundle，以 CJS 互通載入，多繞一層互通層）。
 *
 * 【主鍵設計是整個去重的命脈】w-orm-lmdb 固定以記錄的 id 欄位作為 LMDB key，
 * 且預設（autoGenPk:true）在 id 不是非空字串時自動產生隨機值——隨機 id 代表
 * 每次寫入都是新 key，去重會靜默失效。故本層做兩道防線：①開庫時一律
 * autoGenPk:false，讓 ORM 本身拒收無 id 之記錄；②assertId 先擋，給出可讀的
 * 錯誤訊息並額外檢查 key 長度上限。
 *
 * 【path／db／cl 三者皆必填】w-orm-lmdb 對缺漏值有預設（db 缺 → 'worm'、cl 缺 → 'test'），
 * 而落錯庫的後果是開到一個空 collection：去重全部落空且沒有任何錯誤訊息，
 * 只看得到「這輪新增特別多」。故此處一律拒收空值，寧可啟動即失敗。cl 另不可為保留名
 * `__wdp_probe__`（replace 自檢探針集合專用）。
 *
 * 【close 不可省】close() 釋放 LMDB env 的檔案鎖。未關閉時 Windows 下該資料夾會被
 * 行程持有，後續刪除靜默失敗，且存活行程仍讀得到舊映射（「刪了、重建了」的假象）。
 *
 * @param {{WOrm:Function, path:string, db:string, cl:string}} opt WOrm 為注入之 ORM 建構函數
 *     （如 w-orm-lmdb 之 WOrm，見上方「WOrm 由外部注入」）
 * @returns {object} 集合物件：{ cl, raw, select, get, insertNew, patch, replace, del, count, close }
 */
export function openCollection(opt = {}) {
    const { WOrm, path, db, cl } = opt
    const bad = (v) => typeof v !== 'string' || v.trim() === ''
    if (typeof WOrm !== 'function') throw new ContractError(`openCollection 的 WOrm（ORM 建構函數）必填，請注入 w-orm-lmdb 之 WOrm 或相容實作`)
    if (bad(path)) throw new ContractError(`openCollection 的 path（LMDB 資料夾）必填且不可為空，收到：${JSON.stringify(path)}`)
    if (bad(db)) throw new ContractError(`openCollection 的 db（資料庫名）必填且不可為空，收到：${JSON.stringify(db)}（省略會落到套件預設的 'worm'，等同開到空庫）`)
    if (bad(cl)) throw new ContractError(`openCollection 的 cl（集合名）必填且不可為空，收到：${JSON.stringify(cl)}`)
    if (cl === PROBE_CL) throw new ContractError(`openCollection 的 cl 不可為保留名 ${PROBE_CL}（replace 自檢探針集合專用，共用會讓探針記錄混入業務集合）`)
    // autoGenPk:false —— 主鍵一律由呼叫端自備（見上方「主鍵設計」）
    const wo = WOrm({ url: path, db, cl, autoGenPk: false })

    return {
        cl,
        raw: wo,

        /**
         * 條件查詢；find 僅支援 w-orm 系列條件白名單，由注入之 WOrm 檢核：欄位等值 {欄:純量}（多欄為 AND）、
         * $eq $ne $gt $gte $lt $lte（值為純量）、$in $nin（值為純量陣列）、文件層 $and $or（值為條件物件之非空陣列）。
         * 不給 find（未給、undefined 或 {}）則回全部；傳了值卻不是條件物件，或使用白名單外之運算子（如 $regex $not $exists），
         * 由 WOrm 整批 reject（須為已實作系列白名單之 WOrm；舊版 WOrm 可能仍接受而不在此保證內）
         */
        select: (find) => wo.select(find),

        /** 主鍵直讀（O(1)，不經 select 的全表掃描）；不存在回 null */
        async get(id) {
            return (await wo.selectByPk(String(id ?? '').trim())) || null
        },

        /**
     * 批次插入去重：回傳實際新增者。
     *
     * 走 LMDB key 路徑（nInserted===1 即為新項目），O(k) 操作，不隨資料量成長而變慢；
     * 「檢查未存在」與「寫入」由 LMDB 於同一寫交易內原子完成（ifNoExists），無競態空窗。
     *
     * 【returnList:true 是這裡的關鍵】聚合計數只回答「有幾筆是新的」，而下游要的是
     *   「是哪幾筆」——fresh 清單決定後續要對誰花錢（補抓內文、送 AI、推播）。
     *   在 1.0.20 提供 returnList 之前，只能逐筆呼叫 insert([單筆]) 以 nInserted===1 反推，
     *   代價是 N 次呼叫，完全用不到 insert 內部「以 Promise.all 一次送出、由 LMDB 合併批次
     *   寫交易」的優化。改為整批送之後，一輪數百筆從 N 次呼叫降為 1 次。
     *
     * 【回傳陣列與輸入等長保序】故可用索引映射回原記錄；套件保證
     *   filter(v => v.nInserted === 1).length 等於聚合模式的 nInserted。
     */
        async insertNew(items) {
            const recs = (items || []).map((it) => ({ ...it, id: assertId(it.id, `insertNew(${cl})`) }))
            if (recs.length === 0) return { added: [], addCount: 0, dupCount: 0 }
            const lt = await wo.insert(recs, { returnList: true })
            const added = recs.filter((_, i) => lt[i]?.nInserted === 1)
            return { added, addCount: added.length, dupCount: recs.length - added.length }
        },

        /**
     * 局部更新（深合併，適合純量欄位；陣列欄位請改用 replace）。id 不存在則插入。
     * 寫入失敗（逐筆結果 ok 非 1）拋錯，訊息帶 cl、id 與儲存層原文 err（本層不放記錄內容）。
     */
        async patch(id, fields) {
            const key = assertId(id, `patch(${cl})`)
            const r = await wo.save([{ ...fields, id: key }])
            assertSaved(r?.[0], 'patch', cl, key)
        },

        /**
     * 整筆取代（含刪鍵與陣列欄位）：於 WOrm 之同一寫交易內以 save 的 merge:false 覆寫，
     * 舊記錄不在新記錄內之鍵不保留、陣列整筆替換。id 不存在則插入。
     *
     * 【不經刪除】舊作法「先 del 再 insert」是兩次獨立寫入：兩步之間失敗則原記錄消失，
     * 兩步之間他者插入同 id 則本次寫入無聲遺失。單一交易覆寫兩種空窗皆不存在，
     * 寫入失敗時原記錄仍在。
     *
     * 【相容需求：WOrm 須為 w-orm-lmdb >= 1.0.41】merge:false 為該版才有之選項，舊版或他後端
     * 會忽略它而當成深合併（舊鍵殘留且不報錯）。故首次 replace 時對注入之 WOrm 做一次性自檢
     * （見 probeMergeFalse，每個 WOrm 建構函數只做一次，於探針集合進行，不碰本集合）；不支援者
     * 在寫入之前拋 ContractError，資料不被誤改。自檢以「支援度為建構函數之性質」為前提
     * （見 probeMergeFalse），會依 cl／path／db 分派到不同後端之工廠不在支援範圍。
     *
     * 寫入失敗（逐筆結果 ok 非 1）拋錯，訊息帶 cl、id 與儲存層原文 err（本層不放記錄內容）。
     */
        async replace(rec) {
            const id = assertId(rec.id, `replace(${cl})`)
            await assertMergeFalse(WOrm, path, db)
            const r = await wo.save([{ ...rec, id }], { merge: false })
            assertSaved(r?.[0], 'replace', cl, id)
        },

        /**
     * 刪除一筆。回傳是否真的刪掉了：存在而刪除回 true，id 不存在回 false。
     * 單筆失敗（逐筆結果 ok 非 1）或整批 reject（如已 close）一律拋錯，不再吞成 false。
     *
     * 【限制】true／false 取自儲存層之 nDeleted。w-orm-lmdb 1.0.41 之 del 先讀存在再刪，非同一交易，
     * 故多個刪除者併發刪同一 id 時可能不只一個回 true（資料庫其實只有一筆可刪）；不可用此回傳值
     * 當成「我是唯一刪除者」之判據。id 照原樣比對（不 trim），與 get／patch／replace 之 trim 不同。
     */
        async del(id) {
            const key = String(id)
            const r = await wo.del({ id: key })
            return assertSaved(r?.[0], 'del', cl, key).nDeleted === 1
        },

        /** 條件計數；find 規則同 select（系列條件白名單），不給 find 則計全部 */
        async count(find) {
            const rs = await wo.select(find)
            return Array.isArray(rs) ? rs.length : 0
        },

        async close() {
            try {
                await wo.close()
            }
            catch { /* 關閉失敗不影響已寫入資料 */ }
        },
    }
}

/**
 * 開啟多個集合並在結束後一律關閉（即使中途拋錯）。
 * @param {{WOrm:Function, path:string, db:string, cls:Record<string,string>}} opt cls：對外名稱 → 實際集合名
 * @param {Function} fn  ((cols)=>Promise)
 * @returns {Promise<any>} fn 的回傳值
 */
export async function withCollections(opt, fn) {
    const cols = {}
    const names = Object.keys(opt.cls || {})
    for (const n of names) cols[n] = openCollection({ WOrm: opt.WOrm, path: opt.path, db: opt.db, cl: opt.cls[n] })
    try {
        return await fn(cols)
    }
    finally {
        for (const n of names) await cols[n].close()
    }
}

export default { openCollection, withCollections }
