import strTruncate from 'wsemi/src/strTruncate.mjs'
import iseint from 'wsemi/src/iseint.mjs'

/**
 * 壓成單行並限長，供日誌顯示。
 *
 * 【為何必要】解析錯誤、CLI stderr 常含換行，直接寫進日誌會讓單筆記錄散成多行，
 * 破壞逐行 grep 與巡檢工具的解析——壓平空白才是本函數存在的理由，截斷是次要的。
 * 截斷委派 wsemi 之 strTruncate：超長才補刪節號、未超長原樣回傳，
 * 讀日誌時才分得出「訊息就這麼短」與「被切掉了」。
 *
 * 【n 之檢查由本函數自行負責】n 以 wsemi iseint 之 count 判定（0～4294967295 之安全整數，
 * 數字或可無損轉數字之字串皆可，如 200、'200'、'1.5e1'）；有效才轉為數字交給 strTruncate，
 * 非有效值（null、負數、小數、Infinity、'abc'、包裝物件、BigInt 等）則不截斷，回壓平後之整行。
 * 不依賴 strTruncate 對無效 maxLen 之處置（其 maxLen 為必須參數，無效即拋錯）。
 *
 * @param {*} s
 * @param {number} [n=200] 最大字元數（不含刪節號）；非有效個數則不截斷
 * @returns {string} 壓平空白後之單行字串；n 有效且超過 n 字則截斷並補上 …
 */
export function oneline(s, n = 200) {
    const line = String(s ?? '').replace(/\s+/g, ' ').trim()
    if (!iseint(n, { use: 'count' })) {
        return line
    }
    return strTruncate(line, Number(n))
}

export default oneline
