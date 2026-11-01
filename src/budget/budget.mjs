// budget.mjs — 整輪時間預算的單一消費介面:各段只問這裡,不各自手寫防禦式判斷(自 srcRunner core/budget.mjs 移入，行為與契約不變)
//
// 【為何需要】截止(deadlineMs)由 w-data-pipeline 的 ctx 持有(remainingMs/expired),各段消費它時若各寫一份
//   「ctx 有沒有這個函數、回值是不是 true」的防禦判斷,寫法必然分歧,且取值時機容易錯:在工作流開工時取一次剩餘時間,
//   序列後段席位拿到的是數十分鐘前的值,截止切不到它。故預算只有一個擁有者,各段呼叫 budgetOf(ctx) 取用。
//
// 【capSeat:席位預算以「開工當下」的剩餘時間封頂】以 getter 定義 budgetMs——w-dispatch-ai 的工作流
//   於各席位開工時才展開席位規格({...seat}),getter 在那一刻求值,序列後段席位自然拿到當時的剩餘時間;
//   dispatchAiFallback 再以剩餘預算封頂每次嘗試之 timeout,進行中的最後一次呼叫才會在截止時被切斷。
//   無截止(ctx 無 remainingMs 或回 Infinity)時原樣回傳,不改行為。
//   (本件只對席位物件做鴨子型別之淺拷貝與 getter 定義，不 import w-dispatch-ai。)

/**
 * 整輪時間預算的單一消費介面:由 ctx 之 remainingMs／expired 衍生出各段共用的封頂與守門函數。
 *
 * 已容錯 ctx 為 null／缺 remainingMs／缺 expired 之情形(測試替身或無截止環境):此時 remainingMs 恆
 * 回 Infinity、expired 恆回 false、capMs 原樣回傳、capSeat 原樣回傳席位物件(不包裝)——皆不拋錯。
 *
 * @param {Object} ctx 輸入 w-data-pipeline 之管道脈絡，可為 null(測試或無截止環境)
 * @param {Function} [ctx.remainingMs] 輸入 ()=>Number，回傳剩餘毫秒數；缺此函數或回傳非有限值時視為無截止
 * @param {Function} [ctx.expired] 輸入 ()=>Boolean，回傳是否已逾整輪截止；缺此函數時視為恆未逾期
 * @returns {Object} 回傳預算介面：
 *   { expired:Function 是否已逾期,
 *     remainingMs:Function 回傳剩餘毫秒數(無截止為 Infinity,負值夾為 0),
 *     shouldStop:Function 與 expired 同一函數(供逐項迴圈之守門語意),
 *     capMs:Function (ms)=>Number 以剩餘時間封頂一個毫秒預算(無截止原樣回傳 ms;非正數之 ms 視為無要求、以剩餘為上限;逾期後仍回 1 不回 0),
 *     capSeat:Function (seat)=>Object 回傳席位物件之淺拷貝，budgetMs 換成 getter(於「開工當下」即被展開之時求值，序列後段席位據此拿到當時剩餘;無截止或 seat 非物件時原樣回傳原物件) }
 * @example
 * let b = budgetOf({ remainingMs: () => 5000, expired: () => false })
 * console.log(b.remainingMs(), b.capMs(10000))
 * // => 5000 5000
 *
 * let b2 = budgetOf(null)
 * console.log(b2.remainingMs(), b2.capMs(10000))
 * // => Infinity 10000
 */
export function budgetOf(ctx) {
    const hasRemaining = typeof ctx?.remainingMs === 'function'

    /** 回傳剩餘毫秒數(無截止為 Infinity;負值夾為 0;非有限值視為無截止) */
    const remainingMs = () => {
        if (!hasRemaining) return Infinity
        const v = ctx.remainingMs()
        return Number.isFinite(v) ? Math.max(0, v) : Infinity
    }

    /** 回傳是否已逾整輪截止(缺 ctx.expired 時恆為 false) */
    const expired = () => (typeof ctx?.expired === 'function' ? ctx.expired() === true : false)

    /**
     * 以剩餘時間封頂一個毫秒預算;無截止時原值回傳
     *
     * @param {Number} ms 輸入欲請求之毫秒數，非正數視為無要求(改以剩餘時間為上限)
     * @returns {Number} 回傳封頂後毫秒數(下限 1,無截止時原樣回傳 ms)
     */
    const capMs = (ms) => {
        const r = remainingMs()
        if (!Number.isFinite(r)) return ms
        return Math.max(1, Math.floor(Math.min(Number.isFinite(ms) && ms > 0 ? ms : r, r)))
    }

    /**
     * 席位規格之 budgetMs 改為開工當下求值(getter);無截止或 seat 非物件時原樣回傳
     *
     * @param {Object} seat 輸入席位規格物件(w-dispatch-ai 之工作流席位，可含 budgetMs)
     * @returns {Object} 回傳席位之淺拷貝(budgetMs 為 getter);無截止或 seat 非物件時回傳原物件
     */
    const capSeat = (seat) => {
        if (!seat || typeof seat !== 'object' || !hasRemaining) return seat
        const base = Number.isFinite(seat.budgetMs) && seat.budgetMs > 0 ? seat.budgetMs : null
        const out = { ...seat }
        Object.defineProperty(out, 'budgetMs', { enumerable: true, configurable: true, get: () => capMs(base ?? remainingMs()) })
        return out
    }

    return { expired, remainingMs, shouldStop: expired, capMs, capSeat }
}

/**
 * 選配段之子預算:扣掉保留給後段之時間後才是本段可用——本段之每次 AI 呼叫以「剩餘−保留」封頂,不得吃進後段之最低時間;
 * 開工門檻由呼叫端依其席位首家逾時決定(canStart)。保留多少由組裝者決定(本函數不讀任何工作之設定)。
 *
 * 【為何不是「剩餘 ≥ 保留＋整條遞補鏈逾時」】鏈逾時是最壞情形(每家都等滿),以它當門檻則選配段在一般輪次幾乎永不開工;
 *   改以呼叫預算封頂,最壞情形由遞補層之 budgetMs 切斷(預算用盡＝skipped,不記失敗)。
 *
 * @param {Object} ctx 輸入管道脈絡(同 budgetOf)
 * @param {Number} reserveMs 輸入保留毫秒數(非負;非有限值或非正數視為 0)
 * @returns {Object} 回傳 { remainingMs:()=>Number 扣保留後之剩餘(無截止為 Infinity), canStart:(minMs)=>Boolean 剩餘是否 ≥ minMs 且未逾期,
 *   shouldStop:(minMs)=>Boolean 即 !canStart(minMs) }
 * @example
 * const b = reserveOf({ remainingMs: () => 2_000_000, expired: () => false }, 900_000)
 * console.log(b.remainingMs(), b.canStart(240_000))
 * // => 1100000 true
 */
export function reserveOf(ctx, reserveMs) {
    const base = budgetOf(ctx)
    const keep = Number.isFinite(reserveMs) && reserveMs > 0 ? reserveMs : 0
    const remainingMs = () => {
        const r = base.remainingMs()
        return Number.isFinite(r) ? Math.max(0, r - keep) : Infinity
    }
    const canStart = (minMs) => !base.shouldStop() && remainingMs() >= (Number.isFinite(minMs) && minMs > 0 ? minMs : 0)
    return { remainingMs, canStart, shouldStop: (minMs) => !canStart(minMs) }
}

/**
 * 保留時間之取值器(各選配段之 opt.reserveMs 與組裝者之每輪依賴 deps.reserveMs 同經此一份規則):毫秒數或 (ctx) => 毫秒數 → (ctx) => 毫秒數。
 *   未給(undefined／null)＝0(不保留)。保留多少屬組裝者(跨工作之時間分配),各段不讀他工作之設定。
 *
 * @param {*} v 輸入保留時間:非負有限數、或 (ctx) => 非負毫秒數;未給為 0
 * @param {String} [where='reserveMs'] 輸入值之出處(錯誤訊息用，如 'stageRetag 之 opt.reserveMs')
 * @returns {Function} 回傳 (ctx) => 非負毫秒數
 * @throws {Error} v 給了而非非負有限數亦非函數時拋出;函數回傳非非負有限數時,呼叫時拋出
 * @example
 * console.log(reserveMsOf(900000)(null), reserveMsOf(undefined)(null), reserveMsOf((ctx) => ctx.n * 2)({ n: 5 }))
 * // => 900000 0 10
 */
export function reserveMsOf(v, where = 'reserveMs') {
    if (v === undefined || v === null) return () => 0
    if (typeof v === 'function') {
        return (ctx) => {
            const ms = v(ctx)
            if (!(Number.isFinite(ms) && ms >= 0)) throw new Error(`${where} 函數須回傳非負毫秒數，收到 ${String(ms)}`)
            return ms
        }
    }
    if (Number.isFinite(v) && v >= 0) return () => v
    throw new Error(`${where} 須為非負毫秒數或 (ctx) => 毫秒數，收到 ${String(v)}`)
}

export default budgetOf
