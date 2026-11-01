const NOOP = () => {}

/**
 * 補齊缺漏的方法，回傳完整的 { info, warn, error, debug }。
 *
 * 【日誌實作可由外部注入，套件另提供可選之預設實作】呼叫端通常已有自己的 logger 與
 * 檔案格式（且常有巡檢工具依固定格式解析），故套件只約定介面 { info, warn, error }，
 * 任何符合者皆可注入；套件另提供 createLogger／createRunLogger（見 src/log/runLogger.mjs）
 * 作為可選之預設實作，不採用者仍照原樣由呼叫端提供實作。
 *
 * 【為何要正規化而非直接呼叫】呼叫端可能只給 { info }，或什麼都不給（單元測試）。
 * 直接呼叫缺漏的方法會在錯誤處理路徑上再拋一次錯，把真正的失敗原因蓋掉。
 *
 * @param {object|null} log 呼叫端的 logger（可為部分實作或 null）
 * @returns {{info:Function, warn:Function, error:Function, debug:Function}} 補齊後的 logger
 */
export function normalizeLogger(log) {
    const pick = (name, fallback) => {
        const f = log && typeof log[name] === 'function' ? log[name].bind(log) : null
        return f || fallback
    }
    const info = pick('info', NOOP)
    const warn = pick('warn', info) // 沒有 warn 就退回 info，不靜默丟棄警告
    const error = pick('error', warn)
    return { info, warn, error, debug: pick('debug', NOOP) }
}

/**
 * 全靜默 logger（測試用）
 * @returns {{info:Function, warn:Function, error:Function, debug:Function}} 各方法皆為空操作的 logger
 */
export function nullLogger() {
    return { info: NOOP, warn: NOOP, error: NOOP, debug: NOOP }
}

export default { normalizeLogger, nullLogger }
