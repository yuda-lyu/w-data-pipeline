/**
 * 限併發的逐項處理，單項失敗不影響其他項。
 *
 * 【為何不用 Promise.all】抓取類任務單項失敗是常態（死連結、被擋、逾時），
 *   Promise.all 會在第一個 rejection 就整批放棄，已完成的結果一併丟失。
 *   本函數採 allSettled 語意：每項各自回 {ok, value|error}，呼叫端全數收得到。
 *
 * 【為何要限併發而非全開】對同一站台全開併發等於自我 DDoS，會被 429／封鎖；
 *   而序列（limit=1）在多來源時又會線性累加撞破排程上限。故併發數由呼叫端依
 *   目標站台的禮貌限制決定，套件不預設樂觀值——預設 1（最保守，行為等同序列）。
 *
 * 【onSettled 一律 await】此回調的實務用途是把該項結果寫回持久層（更新來源統計、
 *   fetchTries、狀態欄位），全是非同步 I/O。不 await 就會出現「mapLimit 已回傳、
 *   呼叫端已關閉資料庫連線，回調才在寫」的競態——寫入丟失，或對已關閉的 env 寫入。
 *   回調自身拋錯不使該項改判成敗（那是兩件事），改記於 settledError 交由呼叫端呈報，
 *   不靜默吞掉：持久化失敗一定要有人看見。
 *
 * @param {Array} items
 * @param {Function} fn  ((item, index)=>Promise)
 * @param {{limit:number, onSettled:Function}} [opt] onSettled 為 ((r, item, index)=>any)
 * @returns {Promise<Array>} 每項為 { ok, value|error, item, index, ms, settledError }；
 *   回傳順序與輸入順序一致（非完成順序），呼叫端可直接 zip 回原陣列
 */
export async function mapLimit(items, fn, opt = {}) {
    const list = Array.isArray(items) ? items : []
    const limit = Math.max(1, Number(opt.limit) || 1)
    const out = new Array(list.length)
    let cursor = 0

    const worker = async () => {
        for (;;) {
            const i = cursor++
            if (i >= list.length) return
            const t0 = Date.now()
            let r
            try {
                r = { ok: true, value: await fn(list[i], i), item: list[i], index: i, ms: Date.now() - t0 }
            }
            catch (error) {
                r = { ok: false, error, item: list[i], index: i, ms: Date.now() - t0 }
            }
            out[i] = r
            if (typeof opt.onSettled === 'function') {
                // 必須 await：回調常是持久化寫入，不等它完成就回傳會與呼叫端的關閉流程競態
                try {
                    await opt.onSettled(r, list[i], i)
                }
                catch (e) {
                    r.settledError = e
                }
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
    return out
}

export default mapLimit
