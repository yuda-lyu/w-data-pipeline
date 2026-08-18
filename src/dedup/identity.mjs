import { resolveKeyOf } from './keyOf.mjs'
import { normalizeUrl, unwrapRedirectUrl, isHttpUrl } from '../util/normalizeUrl.mjs'
import { ContractError } from '../core/errors.mjs'

/**
 * 建立預設的自然鍵取用函數：key（呼叫端明給）→ canonicalUrl（契約層算好的）→ url（現算）。
 *
 * 【為何用 || 而非 ??】契約層把缺漏欄位一律填成空字串（讓下游可安全 .slice），
 *   而 `??` 只在 null／undefined 才落到下一個——`''` 會被當成有效值直接回傳，
 *   於是自然鍵永遠是空的、所有項目都算不出主鍵。這裡要的是「跳過空值」，故用 ||。
 *
 * 【為何 url 這一支要自己現算 canonical】否則身分就依賴「契約層一定先跑過」。
 *   但 seen.has('https://…') 這種鬆散查詢根本沒經過契約層，
 *   若不現算就會拿未正規化的網址去雜湊，同一筆資料查不到自己（帶 utm 的查詢永遠 miss）。
 *   兩條路徑用的是同一組 normalizeUrl／unwrapRedirectUrl，結果必然一致（冪等）。
 */
function makeDefaultIdentityOf(keyOpt = {}) {
    const canonicalize = (url) => normalizeUrl(unwrapRedirectUrl(url, keyOpt.unwrapRules), keyOpt.normalizeUrlOpt)
    return (item) => {
        if (!item || typeof item !== 'object') return ''
        if (item.key) return item.key
        if (item.canonicalUrl) return item.canonicalUrl
        return item.url ? canonicalize(item.url) : ''
    }
}

/** 預設自然鍵取用函數（無額外參數版），供文件與直接引用 */
export const defaultIdentityOf = makeDefaultIdentityOf()

/**
 * 建立身分物件：決定「哪個欄位是自然鍵」以及「怎麼算成主鍵」。
 *
 * 【為何要獨立成一個物件】去重的身分定義會被兩個地方用到：
 * ①契約層（itemContract）——一批項目內要先自我去重，且要把主鍵寫進項目的 id 欄位；
 * ②檢測層（createSeenStore）——判斷是否已抓過、放行時占位。
 * 若兩邊各自算，遲早不一致（例如契約層用正規化後的網址、檢測層用原始網址），
 * 於是批內去重擋掉的與資料庫擋掉的不是同一批，統計看起來像「重複很多」，
 * 實際是自己撞自己。把身分做成可傳遞的物件，兩層共用同一份定義，結構上杜絕不一致。
 *
 * 【泛用性：url 只是預設，不是唯一】抓網頁→什麼都不必給，預設由 url 導出；
 * 抓 API→項目給 key（如 'openalex:W2741809807'）；自訂中間層→identityOf 給任意函數。
 *
 * 【id 永遠是輸出，不是輸入】自然鍵的預設取用順序是 key → canonicalUrl → url，
 * 刻意不讀 item.id——id 是本層算出來的結果，若又拿它當自然鍵，對同一筆項目
 * 算第二次就會變成「雜湊的雜湊」而得到不同的鍵。不讀它，of() 才具冪等性：
 * 同一筆項目算幾次都同值，重算永遠安全。
 *
 * @param {object} spec
 * @param {string|Function} spec.keyOf  **必填**。主鍵策略：'raw'／'asis'／'normalized'／'unwrapped'
 *                                      或自訂函數。不設預設值的理由見 keyOf.mjs 之 resolveKeyOf。
 * @param {Function} [spec.identityOf]  ((item)=>string) 自然鍵取用函數；預設 key → canonicalUrl → url
 * @param {object} [spec.keyOpt]        傳給策略函數的參數（normalizeUrlOpt／unwrapRules）
 * @returns {object} 身分物件：{ naturalKeyOf, of, describe }；of(item) 由項目或鬆散字串算出主鍵，
 *     自然鍵為空時回空字串（呼叫端據此判為無效項）
 */
export function createIdentity(spec = {}) {
    const keyFn = resolveKeyOf(spec.keyOf)
    const keyOpt = spec.keyOpt || {}
    const identityOf = spec.identityOf || makeDefaultIdentityOf(keyOpt)
    if (typeof identityOf !== 'function') throw new ContractError('createIdentity 的 identityOf 必須是函數')

    /**
   * 傳入字串時包成項目再交給 identityOf，而不是直接當自然鍵。
   * 【為何】這樣鬆散查詢（seen.has('https://…')）與正式項目走的是**同一個** identityOf，
   *   自訂 identityOf 也照樣生效；若直接當自然鍵，兩條路徑就會各算各的而查不到自己。
   * 看起來像網址的包成 { url }（會經正規化），其餘包成 { key }（原樣採用）。
   */
    const toItem = (x) => (typeof x === 'string' ? (isHttpUrl(x) ? { url: x } : { key: x }) : x)

    /** 取自然鍵 */
    const naturalKeyOf = (x) => String(identityOf(toItem(x)) ?? '').trim()

    /** 算主鍵；自然鍵為空時回空字串（呼叫端據此判為無效項，不可硬算——
   *  空字串的雜湊是固定值，所有無自然鍵的項目會共用同一個鍵而靜默錯誤去重） */
    const of = (item) => {
        const k = naturalKeyOf(item)
        return k ? keyFn(k, keyOpt) : ''
    }

    return {
        __kind: 'identity',
        naturalKeyOf,
        of,
        /** 可讀摘要，供啟動日誌記錄「這次用什麼身分定義」——事後查去重異常時的第一手證據 */
        describe: () => `keyOf=${typeof spec.keyOf === 'function' ? '(自訂函數)' : spec.keyOf}` +
      `／identityOf=${spec.identityOf ? '(自訂函數)' : 'key→canonicalUrl→url'}`,
    }
}

/**
 * 把 spec 或既有 identity 物件正規化成 identity 物件
 * @param {object} x createIdentity 之產出或其 spec
 * @returns {object} identity 物件
 */
export function resolveIdentity(x) {
    if (x && x.__kind === 'identity') return x
    return createIdentity(x || {})
}

export default createIdentity
