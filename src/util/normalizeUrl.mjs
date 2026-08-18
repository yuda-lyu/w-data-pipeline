/** 預設要剝除的追蹤參數樣式 */
const DEFAULT_DROP_PARAMS = /^(utm_|fbclid|gclid|ref|ref_src|source)/i

/**
 * 正規化 URL：去 hash、去追蹤參數、去尾斜線。
 * 無法解析時原樣回傳（去重仍以字串相等生效，不因畸形網址而拋錯中斷整批）。
 *
 * 【為何要正規化】同一篇文章常帶著不同的追蹤參數（utm_*、fbclid）或尾斜線進來，
 * 直接拿原始 url 當去重鍵，同篇會被當成多篇重複處理，浪費抓取與處理名額。
 * 注意：正規化不是無條件套用的預設，而是 keyOf 策略選項（見 dedup/keyOf.mjs）——
 * 既有資料庫若以原始網址算鍵，接入時務必沿用原策略，否則舊資料等同全部失憶。
 *
 * @param {string} url
 * @param {{dropParams:RegExp}} [opt] dropParams 可覆寫要剝除的參數樣式
 * @returns {string}
 */
export function normalizeUrl(url, opt = {}) {
    const dropParams = opt.dropParams || DEFAULT_DROP_PARAMS
    try {
        const u = new URL(String(url).trim())
        u.hash = ''
        for (const p of [...u.searchParams.keys()]) {
            if (dropParams.test(p)) u.searchParams.delete(p)
        }
        let s = u.toString()
        if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1)
        return s
    }
    catch {
        return String(url || '').trim()
    }
}

/**
 * 轉址解包規則表：{ host, path, param }，命中即取 param 指定的查詢參數為真實網址。
 *
 * 【為何是規則表而非寫死】各聚合站的轉址格式不同，且此清單會隨新來源成長；
 *   規則表讓呼叫端可用 unwrapRedirectUrl(url, [...DEFAULT_UNWRAP_RULES, myRule]) 擴充，
 *   不必改套件。
 *
 * 【為何沒有 Google News】其 /rss/articles/<AU_yqL…> 是不透明 ID，
 *   真實網址「不在」連結內，離線不可解（實測 base64 解開無 URL），故無規則可寫。
 */
export const DEFAULT_UNWRAP_RULES = [
    { host: 'bing.com', path: '/news/apiclick', param: 'url' },
]

/**
 * 解開轉址連結，取出真實網址；無規則命中即原樣回傳。
 * @param {string} url
 * @param {Array<{host:string, path:string, param:string}>} [rules]
 * @returns {string}
 */
export function unwrapRedirectUrl(url, rules = DEFAULT_UNWRAP_RULES) {
    try {
        const u = new URL(String(url).trim())
        const host = u.hostname.replace(/^www\./, '')
        for (const r of rules) {
            if (host !== r.host) continue
            if (r.path && !u.pathname.startsWith(r.path)) continue
            const target = u.searchParams.get(r.param)
            if (target && /^https?:\/\//i.test(target)) return target
        }
        return String(url).trim()
    }
    catch {
        return String(url || '').trim()
    }
}

/**
 * 是否為可抓取的 http(s) 網址（去重與抓取的最低門檻）
 * @param {string} url
 * @returns {boolean}
 */
export function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || '').trim())
}

export default { normalizeUrl, unwrapRedirectUrl, isHttpUrl, DEFAULT_UNWRAP_RULES }
