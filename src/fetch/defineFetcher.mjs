import { ContractError } from '../core/errors.mjs'

const ROLES = new Set(['list', 'detail'])

/**
 * 宣告一個抓取器（依賴注入）。
 *
 * 【為何抓取器必須由外部注入】「怎麼抓」跟站台強綁：多數 feed 用 curl 就夠，
 * 有些站台以 TLS 指紋擋非瀏覽器用戶端（補 header 治不了），再嚴的只能上
 * 真瀏覽器（playwright 之類），且這條光譜會隨站台改版變動。套件若內建抓法，
 * 等於把最易變的部分焊死在最難改的地方。故套件只定義：接什麼、回什麼、
 * 失敗怎麼算，抓法整段由外部給。
 *
 * 【兩種角色】role:'list' 接來源回項目清單（fetch(source, ctx) → Array<rawItem>）；
 * role:'detail' 接項目回內文（fetch(item, ctx) → { ok, text, title } 或
 * { status:'success', content }）。由 role 決定套件用哪套契約檢查回傳值
 * （見 itemContract.mjs）。
 *
 * 【定義期就檢查】漏寫 fetch、role 打錯字都屬設定錯誤：靜默略過會讓某類來源
 * 從此再也不被抓，而日誌上只看得到「這輪沒新資料」——最難察覺的失效樣態。
 *
 * @param {object} spec
 * @param {string} spec.id                    抓取器識別（清單內須唯一，日誌與統計用）
 * @param {'list'|'detail'} [spec.role='list']
 * @param {Function} spec.fetch               實作：list → (source, ctx, opt)；detail → (item, ctx, opt)。
 *                                            opt 為 { signal, attempt }：signal 是本次嘗試的 AbortSignal
 *                                            （逾時當下觸發，合作式取消，見 attemptFetch.mjs）；
 *                                            不處理 signal 也能運作，但逾時的工作會在背景跑完。
 * @param {string[]} [spec.kinds]             處理哪些 target.kind（list 角色比對 source.kind，
 *                                            detail 角色比對 item.kind）
 * @param {Function} [spec.match]  ((target, ctx)=>boolean) 自訂判定；kinds 未命中時才評估
 * @param {number} [spec.timeoutMs]           單次抓取硬上限；未給則用執行時的全域值
 * @param {number} [spec.retries=0]           同一目標的重試次數（不含首次）。抓取器若不處理
 *                                            signal，逾時後的重試會與前次重疊執行，請保守
 * @param {number} [spec.retryDelayMs=0]      重試間隔
 * @param {object} [spec.contract]            覆寫此抓取器的契約參數（maxItems／maxTextChars／minTextChars…）
 * @returns {object} 正規化後的抓取器：{ id, role, kinds, match, fetch, timeoutMs, retries, retryDelayMs, contract }
 */
export function defineFetcher(spec) {
    const id = String(spec?.id || '').trim()
    if (!id) throw new ContractError('抓取器缺少 id')

    const role = spec.role || 'list'
    if (!ROLES.has(role)) throw new ContractError(`抓取器[${id}] 的 role 只能是 list／detail，收到：${spec.role}`)
    if (typeof spec.fetch !== 'function') throw new ContractError(`抓取器[${id}] 缺少 fetch 函數`)
    if (spec.match !== undefined && typeof spec.match !== 'function') {
        throw new ContractError(`抓取器[${id}] 的 match 必須是函數`)
    }
    const kinds = spec.kinds === undefined ? [] : spec.kinds
    if (!Array.isArray(kinds)) throw new ContractError(`抓取器[${id}] 的 kinds 必須是陣列`)
    // 非負整數：底層 pmTimeout 對非整數會拋 invalid ms，於定義期擋下才不會跑到一半才爆
    if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 0)) {
        throw new ContractError(`抓取器[${id}] 的 timeoutMs 須為非負整數（0 代表不設限），收到：${spec.timeoutMs}`)
    }

    return {
        __kind: 'fetcher',
        id,
        role,
        kinds: kinds.map(String),
        match: spec.match || null,
        fetch: spec.fetch,
        timeoutMs: Number.isInteger(spec.timeoutMs) ? spec.timeoutMs : 0,
        retries: Math.max(0, Number(spec.retries) || 0),
        retryDelayMs: Math.max(0, Number(spec.retryDelayMs) || 0),
        // 註：不設逐抓取器 concurrency 欄位——runner 未實作該能力，宣告了等於「會說謊的文件」；
        // 併發上限由 runner 的全域 concurrency 控制，真有需求時再於 runner 內建逐抓取器 semaphore。
        contract: spec.contract || {},
    }
}

export default defineFetcher
