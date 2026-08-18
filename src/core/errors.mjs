/**
 * 契約違反：注入物不符約定（缺欄位、型別錯、id 重複）。屬設定錯誤，不可續行。
 *
 * 【為何要錯誤型別而非字串】呼叫端要能分流處理「設定寫錯」與「執行期失敗」：
 * 前者不會自行恢復（打錯 id、抓取器沒註冊），必須以 ERROR 突顯並停機；
 * 後者是常態（來源掛掉、逾時），只需記錄並跳過。靠訊息字串比對分流會隨措辭改寫
 * 而失準，故一律以型別與 code 判別。
 */
export class ContractError extends Error {
    constructor(message, detail = {}) {
        super(message)
        this.name = 'ContractError'
        this.code = 'CONTRACT'
        Object.assign(this, detail)
    }
}

/** 階段執行失敗：包住原始錯誤並標明是哪個階段，避免堆疊追到套件內部就斷線 */
export class StageError extends Error {
    constructor(stageName, cause) {
        super(`階段[${stageName}] 失敗：${cause?.message || cause}`)
        this.name = 'StageError'
        this.code = 'STAGE'
        this.stageName = stageName
        this.cause = cause
    }
}

/**
 * 子管道失敗：**巢狀管道用來把失敗往上傳的載具**。
 *
 * 【為何非有不可】管道作為父管道的一個階段執行時，若只回傳 report（即使 ok:false）而不拋出，
 *   父層的 `await st.run(ctx)` 就是成功解析，該階段被記成 status:'ok'，
 *   而該子管道自己宣告的 onError:'abort'|'continue' 永遠不會被評估——旗標形同死碼。
 *   結果是「fetch 段整段失敗，父層報告卻說一切正常」，巡檢也抓不到。
 *   故子管道失敗一律以本型別拋出，並把完整 report 掛在錯誤上，
 *   讓父層既能依 onError 決策，也不會遺失子段的逐段明細。
 */
export class PipelineError extends Error {
    constructor(pipelineName, report) {
        super(`管道[${pipelineName}] 失敗：${report?.error?.message || '未知原因'}`)
        this.name = 'PipelineError'
        this.code = 'PIPELINE'
        this.pipelineName = pipelineName
        /** 完整的子管道報告（逐段狀態、耗時、各段結果），供父層記錄與巡檢解析 */
        this.report = report
        this.cause = report?.error
    }
}

/**
 * 是否為逾時錯誤。
 *
 * 逾時由 wsemi 之 pmTimeout 拋出，以 `code === 'TIMEOUT'` 標記。
 * 【為何要這個判別式】逾時與「來源自身報錯」必須能分流統計：
 *   前者代表對方慢或卡住（可能下輪就好），後者代表對方明確拒絕（可能要換抓取器或停用來源）。
 *   靠錯誤訊息字串比對會隨措辭改寫而失準，故一律看 code。
 */
export function isTimeoutError(e) {
    return !!e && e.code === 'TIMEOUT'
}

export default { ContractError, StageError, PipelineError, isTimeoutError }
