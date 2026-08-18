import pmTimeout from 'wsemi/src/pmTimeout.mjs'
import { isTimeoutError } from '../core/errors.mjs'

/**
 * 單一目標的抓取嘗試：依抓取器宣告之 retries／retryDelayMs 重試；逾時亦算一次失敗並可重試。
 *
 * 【為何獨立成檔】兩個 runner（runListFetch／runDetailFetch）共用同一份嘗試行為，
 * 任何行為修正只需落在一處。內部共用，不進 WDataPipeline.mjs 公開面——
 * 它是 runner 的實作細節，不是呼叫端的積木。
 *
 * 【取消是合作式的，不是強制的】JS 無法中止已啟動的 Promise：逾時只代表「不再等待」，
 * 抓取工作（尤其子進程）仍會跑到自然結束。本函數每次嘗試建立一個 AbortController，
 * 以第三參數 { signal, attempt } 交給抓取函數——有接 signal 的實作（原生 fetch、
 * 可中止的子進程包裝）會在逾時當下被通知收工；沒接的實作則繼續跑，此時若
 * retries > 0，下一次嘗試會與前一次重疊執行，對同一站台等於瞬間雙倍請求，
 * 子進程的回收也是呼叫端責任。故：抓取器若不處理 signal，retries 請保守（預設 0 即是）。
 *
 * @param {object} fetcher defineFetcher 之產出
 * @param {*} target list 角色為 source，detail 角色為 item
 * @param {object} ctx 管道脈絡（原樣轉交）
 * @param {number} timeoutMs 單次嘗試上限；0 代表不設限
 * @returns {Promise<*>} 抓取函數的原始回傳值（格式檢查由呼叫端的契約層負責）
 */
export async function attemptFetch(fetcher, target, ctx, timeoutMs) {
    let last
    for (let i = 0; i <= fetcher.retries; i++) {
        const ac = new AbortController()
        try {
            // timeoutMs 為 0 代表「未設上限」（見 defineFetcher）；pmTimeout 的 0 是
            // 「下一輪事件迴圈即逾時」——語意正好相反，故必須先擋，不可直接把 0 交進去
            const pm = Promise.resolve(fetcher.fetch(target, ctx, { signal: ac.signal, attempt: i }))
            return await (timeoutMs > 0 ? pmTimeout(pm, timeoutMs, { label: `抓取器[${fetcher.id}]` }) : pm)
        }
        catch (e) {
            // 逾時當下通知該次嘗試收工（合作式取消，見上方說明）；
            // 一般失敗時 promise 已 settle，abort 為無作用之空操作，無害
            if (isTimeoutError(e)) ac.abort()
            last = e
            if (i < fetcher.retries && fetcher.retryDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, fetcher.retryDelayMs))
            }
        }
    }
    throw last
}

export default attemptFetch
