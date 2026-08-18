import strTruncate from 'wsemi/src/strTruncate.mjs'

/**
 * 壓成單行並限長，供日誌顯示。
 *
 * 【為何必要】解析錯誤、CLI stderr 常含換行，直接寫進日誌會讓單筆記錄散成多行，
 * 破壞逐行 grep 與巡檢工具的解析——壓平空白才是本函數存在的理由，截斷是次要的。
 * 截斷委派 wsemi 之 strTruncate：超長才補刪節號、未超長原樣回傳，
 * 讀日誌時才分得出「訊息就這麼短」與「被切掉了」。
 *
 * @param {*} s
 * @param {number} [n=200] 最大字元數（不含刪節號）
 * @returns {string} 壓平空白後之單行字串；超過 n 字則截斷並補上 …
 */
export function oneline(s, n = 200) {
    return strTruncate(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
}

export default oneline
