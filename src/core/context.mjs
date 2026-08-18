/**
 * 建立管道執行脈絡：跨階段共享的資料袋、相依注入、以及時間預算。
 *
 * 【為何要 bag 而非「上一階段回傳值直接餵下一階段」】管道有兩種常見形態：
 * 資料接力型（各階段像 pipe 一路傳值）與共用資料庫型（各階段都對同一儲存層讀寫、
 * 彼此不直接傳值，像 batch job）。若只支援 pipe，後者要靠閉包外的變數；
 * 若只支援 batch，前者要自己另建暫存。bag（具名共享袋）兩者皆可承載：
 * 接力型寫 ctx.set('items', …)、共用型完全不碰 bag；
 * 上一階段回傳值另以 ctx.prev 提供，接力型可直接取用。
 *
 * 【為何要 deadline 而非只靠各階段 timeout】排程視窗（如每輪 55 分鐘）約束的是
 * 整條管道，而逐階段 timeout 管不了「整條管道還剩多少時間」；階段內部需要能問
 * 「我還剩多久」以決定本輪要處理幾筆（軟性截止），否則就只能被排程硬砍、
 * 當輪成果全部丟失。故 ctx 提供 remainingMs() 供階段自行收斂。
 *
 * @param {object} [opt]
 * @param {object} [opt.deps]      相依注入（stores／settings／ai 等，套件不解讀內容）
 * @param {object} [opt.log]       已正規化之 logger
 * @param {number} [opt.deadlineMs] 整條管道的軟性時間預算（毫秒）；未給即不設限
 * @param {AbortSignal} [opt.signal]
 * @returns {object} 脈絡物件：{ deps, log, signal, prev, stage, get, set, has, snapshot,
 *     elapsed, remainingMs, expired }
 */
export function createContext(opt = {}) {
    // bagMap 供「巢狀管道derive 子脈絡」時共用同一份資料袋——
    // 子管道（＝一個執行階段，如 fetch 段）可有自己的 logger 與時間預算，
    // 但資料必須與父管道相通，否則接力型流程在跨段時會斷掉。
    const bag = opt.bagMap instanceof Map ? opt.bagMap : new Map(Object.entries(opt.bag || {}))
    const startedAt = Date.now()
    const deadlineAt = Number.isFinite(opt.deadlineMs) && opt.deadlineMs > 0
        ? startedAt + opt.deadlineMs
        : null

    return {
        deps: opt.deps || {},
        log: opt.log,
        signal: opt.signal,
        startedAt,
        deadlineAt,

        /** 上一個成功階段的回傳值（接力型管道用） */
        prev: undefined,
        /** 目前執行到的階段名（供階段內部組日誌前綴） */
        stage: '',

        /** 內部：供 definePipeline derive 子脈絡時共用資料袋，呼叫端不應直接使用 */
        __bagMap: bag,

        get: (k, fallback) => (bag.has(k) ? bag.get(k) : fallback),
        set: (k, v) => {
            bag.set(k, v); return v
        },
        has: (k) => bag.has(k),
        /** 快照（供收尾摘要或除錯輸出，回傳複本以免外部誤改） */
        snapshot: () => Object.fromEntries(bag),

        /** 已耗時（秒，一位小數），日誌用 */
        elapsed: () => ((Date.now() - startedAt) / 1000).toFixed(1),
        /** 距軟性截止還剩多少毫秒；未設截止回 Infinity */
        remainingMs: () => (deadlineAt == null ? Infinity : Math.max(0, deadlineAt - Date.now())),
        /** 是否已逾軟性截止或被中止 */
        expired: () => (deadlineAt != null && Date.now() >= deadlineAt) || !!opt.signal?.aborted,
    }
}

export default createContext
