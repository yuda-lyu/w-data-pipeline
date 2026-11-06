// runLogger.mjs — 內建日誌:每次執行一份日誌檔(兩種工廠,同一核心；definePipeline 之 spec.log 的可選預設實作；自執行殼 core/ops/logger.mjs 移入，行為與契約不變)
//   createRunLogger({ root, getISO, echo }):open 與建立分離,檔名 {root}/{day}/{runId}[-{name}].log
//   createLogger(name, { dir, clock, echo }):建構即 open(clock.stamp8(), day, name),檔名 {dir}/{day}/{stamp}-{name}.log
//     (管道類消費端所用;另附 now／cliFail／elapsed)
//
// 【格式是套件契約】排程執行沒有 console 可看,日誌是唯一的事後診斷來源;消費端之巡檢依此格式(檔名 {day}/{stamp}-{name}.log、
//   行首「[ISO 時間] 等級 訊息」)解析逐輪統計——改動格式須連動其解析端。
// 【為何每次執行獨立成檔,而非按日／按大小輪替】排程與手動執行會交錯發生,混在同一檔內時,事後要看「某一次執行到底怎麼了」
//   得先從時間戳把行挑出來,而長步驟(抓取、AI 呼叫)跨越數分鐘,兩次執行的行必然互相穿插。一次一檔則可精準讀取該次的
//   完整歷程,也讓「列出最近 N 次執行」變成 ls 而非解析。
// 【為何 open 與建立分離】行程層級的安全網(uncaughtException／unhandledRejection)必須在最早期就掛上,那時尚未決定 runId、
//   也還沒有檔案可寫。分離後,open 之前的訊息仍會輸出 stdout 而不會拋錯,open 之後才落檔——這正是「連 catch 都接不到的
//   例外」需要的行為。createLogger 於建構期即知 stamp 與 name,故包一層立即 open;兩種工廠共用同一份 write。
// 【為何同時輸出 stdout】手動執行時可即時觀察進度;排程執行時無人接收,無副作用。echo:false 可關(測試)。
// 【為何寫檔失敗要吞掉】日誌是診斷手段而非業務目的,因磁碟滿或權限問題中斷整條管線是本末倒置。
// 【同時提供兩套方法名】log／logWarn／logError 供人直接呼叫;info／warn／error 是多數套件(如 w-data-pipeline)約定的
//   logger 介面,可把本物件整個傳進去而不必在呼叫端手寫轉接。
// 【clock 為鴨子型別】createLogger 只呼叫 clock.stamp8() 與 clock.iso8,不 import 任何時鐘實作(可傳 wsemi genClockTZ 之產物)。

import fs from 'fs'
import path from 'path'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import isobj from 'wsemi/src/isobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import execCliFailDetail from 'wsemi/src/execCliFailDetail.mjs'

/**
 * 建立通用日誌工廠:open 與建立分離,行程層級安全網可在最早期掛上(此時尚未決定 runId、也還沒有檔案可寫)。
 * open 前之訊息仍輸出 stdout 而不拋錯,open 後才落檔(fs.appendFileSync);同時輸出 stdout 供手動執行即時觀察，
 * 排程執行則無人接收、無副作用；寫檔失敗吞掉不中斷主流程。
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.root 輸入日誌根目錄字串，必填
 * @param {Function} opt.getISO 輸入時區錨定之時間戳函數，必填(如 wsemi genClockTZ 產物之 iso8／getISO)
 * @param {Boolean} [opt.echo=true] 輸入是否同時輸出 stdout
 * @returns {Object} 回傳 { open(runId,day?,name?), file, log／logWarn／logError, info／warn／error, withTag(tag) }
 * @throws {Error} 缺 root 或 getISO 非函數時拋出
 * @example
 * need test in nodejs.
 *
 * let lg = createRunLogger({ root: './log', getISO: () => new Date().toISOString() })
 * lg.open('20260921120000')
 * lg.log('hello')
 */
export function createRunLogger(opt = {}) {

    //check
    if (!isobj(opt)) {
        opt = {}
    }

    const { root, getISO, echo = true } = opt
    if (!isestr(root)) throw new Error('createRunLogger 需要 root')
    if (!isfun(getISO)) throw new Error('createRunLogger 需要 getISO（時區錨定之時間戳函數）')
    let file = null

    /**
     * 寫一行日誌(帶時間戳與層級);落檔失敗僅吞掉不拋出，echo 開啟時同時輸出 stdout
     *
     * @param {String} level 輸入層級標籤字串(如 'INFO '、'WARN '、'ERROR')
     * @param {*} msg 輸入訊息內容
     * @returns {String} 回傳組好之整行字串
     */
    const write = (level, msg) => {
        const line = `[${getISO()}] ${level} ${msg}`
        if (file) {
            try {
                fs.appendFileSync(file, line + '\n', 'utf8')
            }
            catch { /* 日誌寫入失敗不影響主流程 */ }
        }
        if (echo) console.log(line)
        return line
    }
    /** 寫入一行 INFO 層級日誌 */
    const log = (msg) => write('INFO ', msg)
    /** 寫入一行 WARN 層級日誌 */
    const logWarn = (msg) => write('WARN ', msg)
    /** 寫入一行 ERROR 層級日誌 */
    const logError = (msg) => write('ERROR', msg)

    return {
    /**
     * 建立當次執行的日誌檔並開始落檔,回傳其路徑。
     * @param {String} runId 輸入本次執行識別字串(預設形態 YYYYMMDDHHmmss)
     * @param {String} [day] 輸入日期分層目錄名，未給時取 runId 前 8 碼
     * @param {String} [name] 輸入檔名尾碼，給了成 {runId}-{name}.log(createLogger 用)
     * @returns {String} 回傳日誌檔路徑
     */
        open: (runId, day, name) => {
            const dir = path.join(root, day || String(runId).slice(0, 8))
            fsCreateFolder(dir)
            file = path.join(dir, `${runId}${name ? `-${name}` : ''}.log`)
            return file
        },
        /** 當次日誌檔路徑(尚未 open 時為 null) */
        get file() {
            return file
        },
        log,
        logWarn,
        logError,
        info: log,
        warn: logWarn,
        error: logError,
        /**
         * 帶前綴之子記錄器(如各步驟標籤),前綴一致才能事後以 grep 逐步驟抽取
         *
         * @param {String} tag 輸入前綴字串(如 '步驟1：')
         * @returns {Object} 回傳 { log, logWarn, logError, info, warn, error }，各方法呼叫時自動於訊息前加上 tag
         */
        withTag: (tag) => {
            const wrap = (f) => (msg) => f(`${tag}${msg}`)
            const l = wrap(log)
            const w = wrap(logWarn)
            const e = wrap(logError)
            return { log: l, logWarn: w, logError: e, info: l, warn: w, error: e }
        },
    }
}

/**
 * 日誌工廠:建構即開檔 {dir}/{day}/{stamp}-{name}.log(管道類消費端所用)。
 *
 * @param {String} name 輸入日誌名字串(檔名尾段)，必填
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.dir 輸入日誌根目錄字串，必填
 * @param {Object} opt.clock 輸入時鐘物件，必填；鴨子型別，只呼叫其 stamp8() 與 iso8(如 wsemi genClockTZ 之產物)
 * @param {Boolean} [opt.echo=true] 輸入是否同時輸出 stdout
 * @returns {Object} 回傳 createRunLogger 之全部方法,另含 now(本次 stamp)、cliFail(r)、elapsed()
 * @throws {Error} name 非有效字串時拋出；opt 缺 dir 或 clock 時拋出
 * @example
 * need test in nodejs.
 *
 * let lg = createLogger('run', { dir: './log', clock: genClockTZ('Asia/Taipei') })
 * lg.info('hello')
 *
 * //作為 definePipeline 之 spec.log（具 info／warn／error 即可）
 * let p = definePipeline({ name: 'job', stages, log: lg })
 */
export function createLogger(name, opt = {}) {

    //check
    if (!isestr(name)) {
        throw new Error('createLogger 需要 name（日誌名）')
    }
    if (!isobj(opt)) {
        opt = {}
    }

    const { dir, clock, echo } = opt
    if (!dir || !clock) throw new Error('createLogger 需要 { dir, clock }')
    const now = clock.stamp8()
    const base = createRunLogger({ root: dir, getISO: clock.iso8, ...(echo === false ? { echo: false } : {}) })
    base.open(now, now.slice(0, 8), name)
    const startedAt = Date.now()
    return {
        open: base.open,
        get file() {
            return base.file
        },
        now,
        log: base.log,
        logWarn: base.logWarn,
        logError: base.logError,
        info: base.info,
        warn: base.warn,
        error: base.error,
        withTag: base.withTag,
        /**
         * 外部 CLI 失敗詳情:錯誤＋嘗試次數＋stderr 前 300 字(格式委派 wsemi execCliFailDetail,不再另寫一份)
         *
         * @param {Object} r 輸入執行結果物件(如 wsemi execCli 之結果)，取 error、attempts、stderr
         * @returns {String} 回傳失敗詳情字串
         */
        cliFail: (r) => `${r?.error || 'unknown'}${execCliFailDetail(r)}`,
        /** 回傳自建構以來經過秒數(字串，小數 1 位) */
        elapsed: () => ((Date.now() - startedAt) / 1000).toFixed(1),
    }
}

export default createLogger
