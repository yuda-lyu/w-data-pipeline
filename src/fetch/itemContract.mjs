import { normalizeUrl, unwrapRedirectUrl, isHttpUrl, DEFAULT_UNWRAP_RULES } from '../util/normalizeUrl.mjs'

/** 轉字串並修剪；null／undefined → 空字串（下游一律可安全 .slice） */
const str = (v) => (v == null ? '' : String(v)).trim()

/**
 * 正規化單一原始項目（抓取器回傳資料的格式約定與檢查）。
 *
 * 這是依賴注入的另一半：外部注入抓取函數，套件負責檢查它回了什麼。
 * 沒有這一層，各抓取器會各自回各自的欄位名（from／source／author 混用、
 * 時間有的是字串有的是 Date），下游每接一個新來源就要多一條 if。
 *
 * 【身分欄位】key＝自然鍵（呼叫端明給，API 型來源用；抓網頁可省略）；
 * url＝原始網址，原樣保留不改寫——它是拿去抓內文的那一個；
 * canonicalUrl＝正規化後的網址（解轉址＋去追蹤參數），供去重比對；
 * id＝主鍵，由 identity 物件算出，是輸出欄位、呼叫端不給。
 * url 與 canonicalUrl 分開的理由：追蹤參數多數可去但並非全部安全
 * （站台可能拿 ref／source 當路由參數），且既有專案若以原始網址算鍵，
 * 原始值被正規化覆蓋就再也拿不回來。分成兩欄後兩種需求各取所需。
 *
 * 【識別門檻】key 與 url 至少要有一個，兩者皆無即無法去重，該項判為無效；
 * 其餘欄位缺了只影響顯示或素材品質。
 *
 * @param {*} raw 抓取器回傳的單一項目
 * @param {object} [opt]
 * @param {object} [opt.identity]   dedup/identity.mjs 之產出；給了才會算出 item.id
 * @param {object} [opt.source]     來源記錄（帶出 sourceId／sourceName／sourceKind／lang）
 * @param {string} [opt.fetcherId]
 * @param {boolean} [opt.unwrap]    false 則不解轉址（預設解）
 * @param {Array} [opt.unwrapRules]
 * @param {object} [opt.normalizeUrlOpt]
 * @param {number} [opt.maxTextChars]
 * @returns {{ok:true, item:object}|{ok:false, reason:string, raw:any}}
 */
export function normalizeItem(raw, opt = {}) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: '項目非物件', raw }

    const key = str(raw.key)
    const url = str(raw.url ?? raw.link ?? raw.href)
    if (!key && !url) return { ok: false, reason: '缺少 key 與 url（無法識別）', raw }

    // url 存在就必須可抓；非 http(s) 的自訂識別請改用 key 欄位，不要塞進 url
    if (url && !isHttpUrl(url)) return { ok: false, reason: `url 非 http(s)：${url.slice(0, 80)}`, raw }

    // 解轉址再正規化。順序不可調換：反了會用轉址網址當去重依據，
    // 同一篇文章從不同入口（不同查詢關鍵字）進來會被當成兩筆
    let canonicalUrl = ''
    if (url) {
        const unwrapped = opt.unwrap === false ? url : unwrapRedirectUrl(url, opt.unwrapRules || DEFAULT_UNWRAP_RULES)
        canonicalUrl = normalizeUrl(unwrapped, opt.normalizeUrlOpt)
    }

    const maxText = Number.isFinite(opt.maxTextChars) ? opt.maxTextChars : 0
    const clamp = (s) => (maxText > 0 ? s.slice(0, maxText) : s)
    const src = opt.source || {}

    const item = {
        id: '', // 下面由 identity 填入
        key,
        url,
        canonicalUrl,
        // 路由欄位：這個「項目」後續補抓時該由誰處理（fetcherRegistry.resolve 讀
        // target.fetcher（指名）與 target.kind）。必須原樣保留——
        // 丟掉的話，項目上寫的 fetcher:'browser' 這類指名會在正規化後遺失，
        // 「這站要用瀏覽器抓」的宣告悄悄失效，退回預設抓取器還不報錯。
        // 注意與 sourceKind 區分：sourceKind 是「列出它的那個來源」的類別（rss／grid），
        // kind 是「這個項目本身」的抓取類別；把 sourceKind 拿去做 detail 路由是語意錯誤
        //（rss 來源列出的文章不需要「rss」內文抓取器）。
        kind: str(raw.kind),
        fetcher: str(raw.fetcher),
        title: str(raw.title ?? raw.name),
        // 時間一律留字串原樣（各來源格式不一：ISO、年份、RFC822）。
        // 套件不解析成 Date——解析失敗要嘛拋錯要嘛靜默填今天，兩者都比留原字串糟。
        time: str(raw.time ?? raw.publishedAt ?? raw.pubDate ?? raw.date),
        author: str(raw.author ?? raw.from),
        lang: str(raw.lang ?? src.lang),
        summary: clamp(str(raw.summary ?? raw.description)),
        // text＝來源自帶的內文（RSS 內嵌全文、論文摘要）。有它就可能不必再補抓網頁。
        text: clamp(str(raw.text ?? raw.content)),
        sourceId: str(src.id),
        sourceName: str(src.name ?? raw.from),
        sourceKind: str(src.kind),
        fetcherId: str(opt.fetcherId),
        // 抓取器自訂欄位：套件不解讀也不驗證，原樣帶給呼叫端
        extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : {},
    }

    if (opt.identity) {
        item.id = opt.identity.of(item)
        if (!item.id) return { ok: false, reason: '無法由 identity 取得自然鍵', raw }
    }
    return { ok: true, item }
}

/**
 * 正規化一批原始項目：逐項檢查 → 批內去重 → 上限截斷。
 *
 * 【批內去重的必要性】同一來源一次回應內就可能有重複（不同查詢關鍵字命中同篇），
 *   不先去重會讓後續的「已抓過」判定被同批內的前一筆自己擋掉，統計上看起來像
 *   「重複很多」，實際是自己撞自己。
 * 【為何用 identity 的自然鍵去重】必須與檢測層用同一份身分定義，否則兩層擋掉的
 *   不是同一批。未給 identity（無去重需求）時才退回預設欄位順序。
 * 【為何截斷在去重之後】先截斷會讓額度被重複項目佔掉，取到的獨立項目變少。
 * 【為何逐項判定而非整批拒絕】單一項目缺識別只代表那一項不可用，整批拒絕會讓
 *   同來源其他正常項目一起消失。壞項目進 invalid 並帶原因回報，由呼叫端決定
 *   要記警告還是忽略——但一定看得見，不靜默丟棄。
 *
 * @param {any} rawItems 抓取函數的回傳值（必須是陣列）
 * @param {object} [opt] 同 normalizeItem，另加 maxItems
 * @returns {{items:Array, invalid:Array<{reason:string, raw:any}>, dupInBatch:number}}
 * @throws {TypeError} 回傳值非陣列——這是抓取器實作錯誤，不可當成「這次沒抓到」
 */
export function normalizeItems(rawItems, opt = {}) {
    if (!Array.isArray(rawItems)) {
        throw new TypeError(`抓取器[${opt.fetcherId || '?'}] 必須回傳陣列，實得 ${rawItems === null ? 'null' : typeof rawItems}`)
    }
    const items = []
    const invalid = []
    const seen = new Set()
    let dupInBatch = 0

    const dedupKeyOf = opt.identity
        ? (it) => opt.identity.naturalKeyOf(it)
        : (it) => it.key || it.canonicalUrl || it.url

    for (const raw of rawItems) {
        const r = normalizeItem(raw, opt)
        if (!r.ok) {
            invalid.push({ reason: r.reason, raw: r.raw }); continue
        }
        const k = dedupKeyOf(r.item)
        if (seen.has(k)) {
            dupInBatch++; continue
        }
        seen.add(k)
        items.push(r.item)
    }

    const maxItems = Number.isFinite(opt.maxItems) && opt.maxItems > 0 ? opt.maxItems : 0
    return { items: maxItems ? items.slice(0, maxItems) : items, invalid, dupInBatch }
}

/**
 * 正規化「補抓內文」抓取器的回傳值。
 *
 * 允許兩種寫法：{ ok:true, text } 與 { status:'success', content }
 * ——後者相容 w-fetch-web 這類既有抓取工具的回傳形狀，接入時不必再包一層轉換。
 *
 * 【兩種產物：text 或 links】detail 抓取不一定產出正文——彙整型貼文（每週精選
 *   這類文章清單頁）本身不是重點，它列出的外部文章連結才是，丟掉連結等於這篇的
 *   全部價值歸零。故契約承認 links 為一對多產物：{ ok:true, links:[{url, text}] }，
 *   正文可為空。成功的判準是「有實質產物」：正文達門檻，或至少一條合法連結。
 *   連結逐條檢查（url 必須是 http(s)，text 供作轉錄後的標題素材），壞連結靜默剔除
 *   ——它們是頁面雜訊（分享按鈕、mailto），不是抓取器實作錯誤。
 *
 * 【extra 在所有路徑都保留】失敗時的 extra 常帶診斷資訊（HTTP 狀態碼、擋牆類型），
 *   丟掉會讓呼叫端的退路邏輯（該重試還是標 dead）無從判斷。
 *
 * @param {any} raw
 * @param {{minTextChars:number, fetcherId:string}} [opt]
 *   minTextChars 未給時門檻為 1——「成功但空正文且無連結」對補抓內文而言沒有意義，
 *   若預設 0 會讓 {ok:true} 空手而回也判成功，呼叫端據此把空字串寫進資料庫。
 * @returns {{ok:boolean, text:string, title:string, links:Array<{url:string,text:string}>,
 *   contentLength:number, reason:string, message:string, extra:object}}
 */
export function normalizeContent(raw, opt = {}) {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, text: '', title: '', links: [], contentLength: 0, reason: 'bad-return', message: `抓取器[${opt.fetcherId || '?'}] 回傳非物件`, extra: {} }
    }

    const ok = raw.ok === true || raw.status === 'success'
    const text = str(raw.text ?? raw.content)
    const title = str(raw.title)
    const extra = raw.extra && typeof raw.extra === 'object' ? raw.extra : {}
    const links = Array.isArray(raw.links)
        ? raw.links
            .map((l) => ({ url: str(l?.url), text: str(l?.text ?? l?.title) }))
            .filter((l) => isHttpUrl(l.url))
        : []

    if (!ok) {
        return {
            ok: false,
            text: '',
            title,
            links: [],
            contentLength: 0,
            reason: str(raw.reason) || 'fetch-error',
            message: str(raw.message),
            extra,
        }
    }
    // 抓回 200 但正文只剩導覽列殘骸，是反爬蟲空殼頁的典型樣態；
    // 判為失敗才能觸發呼叫端的退路（改用 feed 內文／換抓取器／記重試次數）。
    // 有連結產物時不受此門檻約束（彙整貼文的正文本來就無關緊要）。
    const minChars = Number.isFinite(opt.minTextChars) ? opt.minTextChars : 1
    if (text.length < minChars && links.length === 0) {
        return { ok: false, text, title, links: [], contentLength: text.length, reason: 'too-short', message: `正文 ${text.length} 字，低於門檻 ${minChars}，且無連結產物`, extra }
    }
    return { ok: true, text, title, links, contentLength: text.length, reason: '', message: '', extra }
}

export default { normalizeItem, normalizeItems, normalizeContent }
