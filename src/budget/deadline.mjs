// deadline.mjs — 由排程上限推導整輪截止:ISO-8601 時距解析、截止毫秒數(definePipeline 之 spec.deadlineMs 的推導件；自 srcRunner core/deadline.mjs 移入，行為與契約不變)
//
// 【為何需要】排程器之執行上限(如 Windows 工作排程器之 ExecutionTimeLimit)是外部硬上限:撞到即強制終止,連失敗通知都發不出。
//   保證不撞上限要由程式自己規劃每輪時間——整輪截止＝上限減一段安全邊際,邊際吸收排程端啟動延遲、子程序強殺保險與
//   單次外部呼叫超出其逾時之量。上限與截止各專案只該有一份換算,否則改排程時兩處靜默分歧。
// 【下限】上限很短時(數分鐘)減去邊際會過小或為負;截止取下限,寧可讓排程上限去截斷,不讓每段都因預算為負而不開工。
// 【整數】回傳毫秒數一律取整:下游對非整數各自靜默失效(子程序逾時退回預設、預算視為不限、AbortSignal.timeout 拋錯)。

/** 截止之安全邊際(毫秒):截止＝上限 − 邊際 */
export const DEADLINE_MARGIN_MS = 360_000

/** 截止之下限(毫秒) */
export const DEADLINE_FLOOR_MS = 600_000

/**
 * 解析 ISO-8601 時距(僅 PT…H…M…S)為分鐘數
 *
 * 只抓 `PT(\d+)M` 會把 PT1H30M 解成 30 分而讓截止靜默走偏,故時、分、秒三段皆認,寫錯即拋錯。
 *
 * @param {String} s 輸入時距字串(如 PT55M、PT1H30M、PT90S)
 * @returns {Number} 回傳分鐘數(可含小數)
 * @throws {Error} 非上述格式或全無數字時拋出
 * @example
 * console.log(parseIsoDuration('PT1H30M'), parseIsoDuration('PT90S'))
 * // => 90 1.5
 */
export function parseIsoDuration(s) {
    const m = String(s ?? '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
    if (!m || (!m[1] && !m[2] && !m[3])) throw new Error(`須為 ISO-8601 時距（如 PT55M、PT1H30M），收到：${JSON.stringify(s)}`)
    return Number(m[1] || 0) * 60 + Number(m[2] || 0) + Number(m[3] || 0) / 60
}

/**
 * 由排程上限推導整輪截止毫秒數:max(下限, round(上限分鐘 × 60000) − 邊際)
 *
 * @param {Number} limitMin 輸入排程上限分鐘數(非負有限數)
 * @param {Object} [opt={}] 輸入設定物件，非物件視為 {}
 * @param {Number} [opt.marginMs=DEADLINE_MARGIN_MS] 輸入安全邊際毫秒數(非負)，非有效值用預設 360000
 * @param {Number} [opt.floorMs=DEADLINE_FLOOR_MS] 輸入截止下限毫秒數(正數)，非有效值用預設 600000
 * @returns {Number} 回傳截止毫秒數(正整數)
 * @throws {Error} limitMin 非非負有限數時拋出
 * @example
 * console.log(deadlineMsOf(20), deadlineMsOf(55), deadlineMsOf(5))
 * // => 840000 2940000 600000
 *
 * console.log(deadlineMsOf(20, { marginMs: 60000 }))
 * // => 1140000
 *
 * //作為 definePipeline 之 spec.deadlineMs：排程上限 20 分鐘 → 整輪截止 14 分鐘
 * let p = definePipeline({ name: 'job', stages, deadlineMs: deadlineMsOf(20) })
 */
export function deadlineMsOf(limitMin, opt = {}) {

    //check
    if (!(Number.isFinite(limitMin) && limitMin >= 0)) {
        throw new Error(`deadlineMsOf 需要非負之排程上限分鐘數，收到：${String(limitMin)}`)
    }
    if (opt === null || typeof opt !== 'object') {
        opt = {}
    }
    const marginMs = Number.isFinite(opt.marginMs) && opt.marginMs >= 0 ? opt.marginMs : DEADLINE_MARGIN_MS
    const floorMs = Number.isFinite(opt.floorMs) && opt.floorMs > 0 ? opt.floorMs : DEADLINE_FLOOR_MS

    return Math.round(Math.max(floorMs, Math.round(limitMin * 60_000) - marginMs))
}

export default { parseIsoDuration, deadlineMsOf, DEADLINE_MARGIN_MS, DEADLINE_FLOOR_MS }
