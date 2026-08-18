import { mapLimit } from '../util/mapLimit.mjs'
import { isTimeoutError, ContractError } from '../core/errors.mjs'
import { normalizeLogger } from '../util/logger.mjs'
import { oneline } from '../util/oneline.mjs'
import { normalizeContent } from './itemContract.mjs'
import { attemptFetch } from './attemptFetch.mjs'

/**
 * 逐項補抓內文（第二層抓取：項目 → 正文）。
 *
 * 【為何與列表抓取分開】兩者的失敗語意完全不同：來源抓不到＝這輪沒進料
 * （下輪再抓即可）；單篇抓不到＝這一篇可能永遠抓不到（付費牆、死連結），
 * 需要重試計數與放棄門檻，否則死連結會每輪被重抓、永久佔用當輪的抓取配額。
 * 套件負責「抓與計時與格式檢查」，重試計數與放棄門檻屬業務政策，
 * 回傳結果讓呼叫端決定；抓不到正文時的退路（改用 feed 內嵌全文、換抓取器）
 * 亦由呼叫端接，套件只負責回報失敗原因。
 *
 * 【兩種產物】detail 結果可能是正文（text），也可能是連結清單（links，
 * 彙整型貼文的一對多轉錄，見 itemContract 之 normalizeContent）。
 * 轉錄成新文件、改母文件狀態屬業務政策，由呼叫端拿 links 自行處理
 * （通常是餵回 seen.admit）。
 *
 * @param {object} opt
 * @param {Array} opt.items            要補抓的項目（至少含 url；kind／fetcher 可指定抓取器）
 * @param {object} opt.registry        createFetcherRegistry 之產出
 * @param {object} [opt.ctx]
 * @param {object} [opt.log]
 * @param {number} [opt.concurrency=1] 併發（對同一站台請保守）
 * @param {number} [opt.timeoutMs]     全域單次上限（抓取器自身宣告者優先）
 * @param {number} [opt.minTextChars]  正文低於此字數即判失敗（空殼頁防護）
 * @param {boolean} [opt.strictUnhandled=true] 有項目無抓取器可處理時，於開工前整批拋
 *        ContractError（false 則將該項記為失敗並續跑其他項）
 * @param {Function} [opt.onItem]  ((r)=>void)     每項結束時回調（供呼叫端寫回 status／fetchTries）
 * @returns {Promise<{results:Array, stats:object}>}
 */
export async function runDetailFetch(opt = {}) {
    const log = normalizeLogger(opt.log)
    const { registry, ctx } = opt
    const items = Array.isArray(opt.items) ? opt.items : []

    // 抓取器解析前置：設定錯誤（kind 沒對到、指名不存在）不進 mapLimit，
    // 於開工前整批 fail loud——理由同 runListFetch（攤平會讓 strictUnhandled 名不符實）
    const resolved = items.map((item) => ({ item, fetcher: registry.resolve('detail', item, ctx) }))
    const unhandled = resolved.filter((x) => !x.fetcher)
    if (unhandled.length && opt.strictUnhandled !== false) {
        const names = unhandled.map((x) => oneline(x.item?.title || x.item?.url, 40))
        throw new ContractError(`有 ${unhandled.length} 個項目無可用內文抓取器：${names.join('、')}（已註冊：${registry.label()}）`)
    }

    const settled = await mapLimit(resolved, async ({ item, fetcher }) => {
        const label = oneline(item?.title || item?.url, 40)

        if (!fetcher) {
            const msg = `項目[${label}] 無可用內文抓取器（kind=${item?.kind || '未指定'}）`
            return { item, fetcherId: '', ok: false, reason: 'no-fetcher', message: msg, text: '', title: '', links: [], contentLength: 0 }
        }

        const timeoutMs = fetcher.timeoutMs || opt.timeoutMs || 0
        let raw
        try {
            raw = await attemptFetch(fetcher, item, ctx, timeoutMs)
        }
        catch (e) {
            return {
                item,
                fetcherId: fetcher.id,
                ok: false,
                reason: isTimeoutError(e) ? 'timeout' : 'fetch-error',
                message: oneline(e?.message, 300),
                error: e,
                text: '',
                title: '',
                links: [],
                contentLength: 0,
            }
        }

        const c = normalizeContent(raw, {
            fetcherId: fetcher.id,
            minTextChars: fetcher.contract?.minTextChars ?? opt.minTextChars,
        })
        return { item, fetcherId: fetcher.id, ...c }
    }, {
        limit: Math.max(1, Number(opt.concurrency) || 1),
        // 【async 且被 mapLimit await】onItem 的實務用途是把該篇結果寫回資料庫
        //（status／fetchTries／text），全是非同步 I/O。不等它完成就回傳，
        // 呼叫端接著關閉集合時會與這些寫入競態。
        onSettled: async (r, entry) => {
            const item = entry?.item
            const label = oneline(item?.title || item?.url, 40)
            const v = r.ok ? r.value : null
            if (!r.ok) log.warn(`內文[${label}] 失敗：${oneline(r.error?.message, 200)}`)
            else if (v.ok && v.links.length) log.info(`內文[${label}] 成功（連結 ${v.links.length} 條，${v.fetcherId}）`)
            else if (v.ok) log.info(`內文[${label}] 成功（${v.contentLength} 字，${v.fetcherId}）`)
            else log.warn(`內文[${label}] 失敗（${v.reason}：${oneline(v.message, 120)}）`)
            if (typeof opt.onItem === 'function') {
                // 拋錯由 mapLimit 記入 settledError，於下方統一呈報，不在此靜默吞掉
                await opt.onItem(r.ok ? { ...v, ms: r.ms } : { item, ok: false, reason: 'throw', message: oneline(r.error?.message, 300), error: r.error, text: '', title: '', links: [], contentLength: 0, ms: r.ms })
            }
        },
    })

    // 回調失敗須明確呈報：它代表 fetchTries／status 沒寫回，該篇下一輪會被重抓且重試計數不前進
    for (const r of settled) {
        if (!r.settledError) continue
        log.error(`內文[${oneline(r.item?.item?.title || r.item?.item?.url, 40)}] 的 onItem 回調失敗（狀態未寫回）：${oneline(r.settledError?.message, 200)}`)
    }

    const results = settled.map((r, i) => (r.ok
        ? { ...r.value, ms: r.ms }
        : { item: resolved[i].item, fetcherId: '', ok: false, reason: 'throw', message: oneline(r.error?.message, 300), error: r.error, text: '', title: '', links: [], contentLength: 0, ms: r.ms }))

    const stats = {
        total: results.length,
        ok: results.filter((x) => x.ok).length,
        failed: results.filter((x) => !x.ok).length,
        chars: results.reduce((a, x) => a + (x.contentLength || 0), 0),
        links: results.reduce((a, x) => a + (x.links?.length || 0), 0),
    }
    return { results, stats }
}

export default runDetailFetch
