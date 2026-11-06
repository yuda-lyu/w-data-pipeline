// unit-run-logger.test.mjs — 落檔日誌之預設實作:createRunLogger(open 與建立分離、行格式、別名、withTag)、
//   createLogger(建構即開檔、now／elapsed、cliFail 委派 wsemi execCliFailDetail)、輸入檢查
// 來源:自執行殼(w-task-runner)test/unit-runner.test.mjs:80-113(2 案)與 test/unit-check-ops.test.mjs:34-49(2 案)逐字移植,
//   輸入與期望值不變,只改 import 與函數所在(W.createRunLogger／W.createLogger → 直接 import;createClock → wsemi genClockTZ);
//   it 標題前綴標原檔行號
// 執行:npx mocha --no-parallel test/unit-run-logger.test.mjs --timeout 180000(暫存落 test/_tmp/run-logger-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import genClockTZ from 'wsemi/src/genClockTZ.mjs'
import { createRunLogger, createLogger } from '../src/log/runLogger.mjs'

const TMP = path.resolve(`test/_tmp/run-logger-${process.pid}`).replace(/\\/g, '/') // cwd 相對(自套件根執行);帶 pid 後綴使並行之多個 mocha 行程互不干擾;after 清除
const slash = (p) => String(p).replace(/\\/g, '/')

describe('unit-run-logger', function() {

    before(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
        fs.mkdirSync(TMP, { recursive: true })
    })

    after(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    it('[unit-runner:80] createRunLogger：open 前不落檔（只回 stdout，echo:false 靜音）；open 後檔名 {root}/{day}/{runId}.log；別名與 withTag；可帶尾碼', () => {
        const root = `${TMP}/log-run`
        const c = genClockTZ('Asia/Taipei')
        const lg = createRunLogger({ root, getISO: c.getISO, echo: false })
        assert.equal(lg.file, null)
        assert.doesNotThrow(() => lg.logError('before open'), 'open 前記錄不拋錯（行程安全網要在最早期掛上）')
        const f = lg.open('20260921120000')
        assert.equal(slash(f), `${root}/20260921/20260921120000.log`)
        assert.equal(lg.file, f)
        lg.log('a'); lg.logWarn('b'); lg.logError('c'); lg.info('d'); lg.warn('e'); lg.error('f')
        lg.withTag('步驟1：').log('g')
        lg.withTag('步驟2：').warn('h')
        const text = fs.readFileSync(f, 'utf8')
        assert.doesNotMatch(text, /before open/)
        for (const re of [/\] INFO {2}a\n/, /\] WARN {2}b\n/, /\] ERROR c\n/, /\] INFO {2}d\n/, /\] WARN {2}e\n/, /\] ERROR f\n/, /\] INFO {2}步驟1：g\n/, /\] WARN {2}步驟2：h\n/]) assert.match(text, re)
        assert.equal(slash(lg.open('20260921130000', '20260921', 'run')), `${root}/20260921/20260921130000-run.log`)
        assert.throws(() => createRunLogger({ root }), /getISO/)
        assert.throws(() => createRunLogger({ getISO: c.getISO }), /root/)
    })

    it('[unit-runner:100] createLogger：建構即開檔 {dir}/{day}/{stamp}-{name}.log；now／elapsed；cliFail 委派 cliFailDetail', () => {
        const dir = `${TMP}/log-kns`
        const c = genClockTZ('Asia/Taipei')
        const lg = createLogger('run', { dir, clock: c, echo: false })
        assert.match(lg.now, /^\d{14}$/)
        assert.equal(slash(lg.file), `${dir}/${lg.now.slice(0, 8)}/${lg.now}-run.log`)
        lg.info('hello')
        lg.withTag('T:').error('bad')
        assert.match(fs.readFileSync(lg.file, 'utf8'), /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] INFO {2}hello\n\[[^\]]+\] ERROR T:bad\n$/)
        assert.match(lg.elapsed(), /^\d+\.\d$/)
        assert.equal(lg.cliFail({ error: 'Exit code 1', attempts: 2, stderr: 'ENOENT x' }), 'Exit code 1，共試 2 次 → ENOENT x')
        assert.equal(lg.cliFail(null), 'unknown')
        assert.throws(() => createLogger('x', {}), /dir, clock/)
    })

    // ── 新增(原執行殼測試未覆蓋之契約:檔頭所述「寫檔失敗吞掉」「同時輸出 stdout」「兩套方法名」「level 五字元對齊」) ──
    it('[新增] 寫檔失敗吞掉不拋、不中斷:日誌目錄被移除後 log 仍回傳整行', () => {
        const root = `${TMP}/log-swallow`
        const lg = createRunLogger({ root, getISO: () => 'T', echo: false })
        const f = lg.open('20260921120000')
        fs.rmSync(path.dirname(f), { recursive: true, force: true }) // 使 appendFileSync 失敗(父目錄不存在)
        let line = null
        assert.doesNotThrow(() => {
            line = lg.log('lost')
        }, '日誌是診斷手段而非業務目的,寫檔失敗不得中斷主流程')
        assert.equal(line, '[T] INFO  lost')
        assert.ok(!fs.existsSync(f))
    })

    it('[新增] echo 預設開啟時同時輸出 stdout(open 前亦輸出);echo:false 靜音;level 五字元對齊', () => {
        const root = `${TMP}/log-echo`
        const out = []
        const orig = console.log
        console.log = (m) => out.push(m)
        try {
            const lg = createRunLogger({ root, getISO: () => 'T' })
            lg.warn('before open') // open 前:只輸出 stdout
            lg.open('20260921120000')
            lg.info('a')
            lg.error('b')
            const quiet = createRunLogger({ root, getISO: () => 'T', echo: false })
            quiet.log('q')
        }
        finally {
            console.log = orig
        }
        assert.deepEqual(out, ['[T] WARN  before open', '[T] INFO  a', '[T] ERROR b'], 'INFO／WARN 補一空白對齊 ERROR(解析端據此)')
    })

    it('[新增] 兩套方法名為同一函數:info＝log、warn＝logWarn、error＝logError;createLogger 全部沿用', () => {
        const lg = createRunLogger({ root: `${TMP}/log-alias`, getISO: () => 'T', echo: false })
        assert.equal(lg.info, lg.log)
        assert.equal(lg.warn, lg.logWarn)
        assert.equal(lg.error, lg.logError)
        const k = createLogger('run', { dir: `${TMP}/log-alias2`, clock: genClockTZ('UTC'), echo: false })
        for (const m of ['open', 'log', 'logWarn', 'logError', 'info', 'warn', 'error', 'withTag', 'cliFail', 'elapsed']) assert.equal(typeof k[m], 'function', m)
        assert.equal(k.info, k.log)
        assert.equal(k.warn, k.logWarn)
        assert.equal(k.error, k.logError)
    })

    it('[新增] clock 為鴨子型別:只需 stamp8() 與 iso8(),不限 wsemi genClockTZ;行首時間戳取自 iso8', () => {
        const dir = `${TMP}/log-duck`
        const lg = createLogger('duck', { dir, clock: { stamp8: () => '20260102030405', iso8: () => '2026-01-02T03:04:05+08:00' }, echo: false })
        assert.equal(lg.now, '20260102030405')
        assert.equal(slash(lg.file), `${dir}/20260102/20260102030405-duck.log`)
        lg.info('x')
        assert.equal(fs.readFileSync(lg.file, 'utf8'), '[2026-01-02T03:04:05+08:00] INFO  x\n')
    })

    // ── 原 unit-check-ops.test.mjs 之 describe('logger')(:33-49) ──
    describe('logger', function() {
        it('[unit-check-ops:34] createRunLogger：opt 非物件視為 {} 後仍依既有檢查拋錯(root 缺失)，不為 TypeError', () => {
            assert.throws(() => createRunLogger(null), /createRunLogger 需要 root/)
            assert.throws(() => createRunLogger('not-obj'), /createRunLogger 需要 root/)
        })

        it('[unit-check-ops:39] createLogger：name 非有效字串拋新錯；既有 createLogger(\'x\', {}) 仍拋 /dir, clock/；有效輸入行為不變', () => {
            assert.throws(() => createLogger(123, {}), /createLogger 需要 name（日誌名）/)
            assert.throws(() => createLogger('', {}), /createLogger 需要 name（日誌名）/)
            assert.throws(() => createLogger('x', {}), /dir, clock/, '既有訊息不可變')
            const clock = genClockTZ('Asia/Taipei')
            const lg = createLogger('run', { dir: `${TMP}/log-check`, clock, echo: false })
            assert.match(lg.now, /^\d{14}$/)
            lg.info('hello') // 日誌檔於首次寫入時才落地(open 僅建目錄與定檔名)
            assert.ok(fs.existsSync(lg.file), '有效輸入仍正常開檔並可寫入')
        })
    })

})
