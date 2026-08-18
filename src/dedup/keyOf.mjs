import str2sha from 'wsemi/src/str2sha.mjs'
import { normalizeUrl, unwrapRedirectUrl } from '../util/normalizeUrl.mjs'
import { ContractError } from '../core/errors.mjs'

/**
 * SHA-1 十六進位字串（委派 wsemi 之 str2sha，n=1 即 SHA-1）。
 *
 * 【換演算法前必須逐項比對】既有資料庫之主鍵一旦綁定 SHA-1，雜湊值只要有一個位元不同，
 *   全部舊資料就會算出新鍵、被當成新項目重新抓取、重新處理、重新推播。
 *   實測 str2sha(s, 1) 與 crypto.createHash('sha1').update(s) 對
 *   ASCII、中文、IDN 網址、2000 字長串、控制字元共 10 類輸入輸出完全相同；
 *   test/unit-identity-dedup.test.mjs 以獨立參考實作（node crypto）逐類釘住。
 *
 * 【空輸入回空字串，這是刻意的】合法雜湊會讓所有「無自然鍵」的項目共用同一個 LMDB key，
 *   造成靜默的錯誤去重（第二筆之後全被判為重複）；回 '' 則被 identity 判為無自然鍵、
 *   被 assertId 擋下，屬 fail-safe。正常路徑走不到——identity.of() 在自然鍵為空時已短路。
 */
const sha1 = (s) => str2sha(String(s ?? ''), 1)

export const keyStrategies = {
    /**
   * 原樣雜湊：sha1(自然鍵.trim())。**適用於任何字串**，非網址專用。
   * 自然鍵若已在上游處理好（如契約層算出的 canonicalUrl、API 的供應商 id），用這個。
   */
    raw: (key) => sha1(String(key ?? '').trim()),

    /**
   * 原樣採用：主鍵＝自然鍵本身，不雜湊。
   * 適用於自然鍵本身就短且唯一的來源（如 'arxiv:2401.12345'）——
   * 好處是 LMDB 裡的鍵人眼可讀，除錯時不必反查雜湊。
   * 注意：長度上限由 openCollection 檢查（1000 bytes），過長請改用 raw。
   */
    asis: (key) => String(key ?? '').trim(),

    /** 網址正規化後雜湊：自然鍵是「未處理的原始網址」時用。已正規化過的再算一次仍得同值（冪等）。 */
    normalized: (key, opt = {}) => sha1(normalizeUrl(key, opt.normalizeUrlOpt)),

    /** 解轉址＋正規化後雜湊：自然鍵是「可能帶轉址的原始網址」時用。 */
    unwrapped: (key, opt = {}) => sha1(normalizeUrl(unwrapRedirectUrl(key, opt.unwrapRules), opt.normalizeUrlOpt)),
}

/**
 * 解析 keyOf 設定為函數。
 *
 * 【兩層概念，別混在一起】自然鍵（natural key）是業務上識別一筆資料的字串
 * （抓網頁→網址；抓 API→供應商流水號；自訂中間層→自己組的唯一字串）；
 * 主鍵（id）是實際拿去當儲存層 key 的字串，由自然鍵經本檔的策略算出。
 * 本檔只管「自然鍵 → 主鍵」這一步，不管自然鍵從哪個欄位來——那是 identity.mjs 的事。
 *
 * 【為何 keyOf 沒有預設值】主鍵一旦改動，既有資料庫等同全部失憶：舊項目算出新鍵、
 * 查不到、被當成新項目重新抓取與處理。不同專案接入時的既有鍵策略往往不同
 * （有的以原始網址雜湊、有的以正規化後網址雜湊），設任一全域預設都會逼另一方遷移，
 * 故一律強迫呼叫端明示。
 *
 * @param {string|Function} keyOf 策略名或自訂函數 (naturalKey, opt) => string
 * @returns {Function} 主鍵策略函數 (naturalKey, opt) => string
 * @throws {ContractError} keyOf 非函數且非已知策略名時拋出（含未指定——keyOf 無預設值）
 */
export function resolveKeyOf(keyOf) {
    if (typeof keyOf === 'function') return keyOf
    const name = String(keyOf || '')
    const f = keyStrategies[name]
    if (!f) {
        throw new ContractError(`未知的主鍵策略：${name || '(未指定)'}（可用：${Object.keys(keyStrategies).join('、')}，或傳入自訂函數）`)
    }
    return f
}

export default { keyStrategies, resolveKeyOf }
