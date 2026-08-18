import { ContractError } from './errors.mjs'

const ON_ERROR = new Set(['abort', 'continue'])

/**
 * 宣告一個管道階段：「一件事 + 它失敗時怎麼辦」。
 *
 * 重點不在把函數排成陣列，而在把散落於流程碼的容錯決策變成可宣告的欄位：
 * onError（這段掛了要中止整條管道，還是繼續下一段——例如「進料段失敗不得阻斷
 * 後續彙整段」與「任一步驟失敗即中止並發通知」兩種政策，差別只在這一個旗標）、
 * always（前面已中止時這段還要不要跑——收尾巡檢、失敗通知、關閉資源皆屬之）、
 * when（這輪要不要跑）。把這三件事宣告化，流程碼才不會退化成層層 try/catch 與旗標變數。
 *
 * 【為何定義期就檢查】漏給 run、名稱重複、onError 打錯字，都是設定錯誤而非執行期失敗，
 * 靜默容忍會讓管道「少跑了一段而沒人發現」——最難察覺的失效樣態，故一律定義期拋錯。
 *
 * @param {object} spec
 * @param {string} spec.name                     階段名（日誌與統計的識別，管道內須唯一）
 * @param {Function} spec.run  ((ctx)=>any)                  實作；回傳值進 ctx.prev，
 *                                               回傳 { stop:true, reason } 可要求停止後續階段
 * @param {'abort'|'continue'} [spec.onError='abort'] 失敗時中止整條管道或繼續
 * @param {boolean} [spec.always=false]          已停止／已中止時仍要執行（收尾用）
 * @param {Function} [spec.when]  ((ctx)=>boolean)           條件執行；回 false 即跳過
 * @param {number} [spec.timeoutMs]              本階段硬上限；未給即不設限
 * @param {Function} [spec.summary]  ((result, ctx)=>string) 由回傳值組出日誌摘要字串
 * @returns {object} 正規化後的階段
 */
export function defineStage(spec) {
    const name = String(spec?.name || '').trim()
    if (!name) throw new ContractError('階段缺少 name')
    if (typeof spec.run !== 'function') throw new ContractError(`階段[${name}] 缺少 run 函數`)

    const onError = spec.onError || 'abort'
    if (!ON_ERROR.has(onError)) {
        throw new ContractError(`階段[${name}] 的 onError 只能是 abort／continue，收到：${spec.onError}`)
    }
    if (spec.when !== undefined && typeof spec.when !== 'function') {
        throw new ContractError(`階段[${name}] 的 when 必須是函數`)
    }
    if (spec.summary !== undefined && typeof spec.summary !== 'function') {
        throw new ContractError(`階段[${name}] 的 summary 必須是函數`)
    }
    // 非負整數：底層 pmTimeout 對非整數會拋 invalid ms。在定義期擋下，
    // 才不會讓一個設定值的筆誤變成跑到一半才爆的執行期錯誤
    if (spec.timeoutMs !== undefined && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 0)) {
        throw new ContractError(`階段[${name}] 的 timeoutMs 須為非負整數（0 代表不設限），收到：${spec.timeoutMs}`)
    }

    return {
        name,
        run: spec.run,
        onError,
        always: !!spec.always,
        when: spec.when || null,
        timeoutMs: Number.isInteger(spec.timeoutMs) ? spec.timeoutMs : 0,
        summary: spec.summary || null,
        /** 標記為階段（供 definePipeline 辨識巢狀管道與階段） */
        __kind: 'stage',
    }
}

export default defineStage
