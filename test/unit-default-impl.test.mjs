// unit-default-impl.test.mjs — 預設實作(執行鎖、截止推導、預算介面、落檔日誌)與 definePipeline 之整合
// 依據:建議w-data-pipeline調整.md §7-2(definePipeline 連跑兩次於持鎖期間 → report.lockSkipped === true、日誌含「略過本輪」)、
//   §7-3(同行程雙取:第二個必 ok:false 且 message 含「本行程已持有此鎖」;release 後可再取得);主入口與深層路徑為同一份實作(HELD 單一份)
// 說明:同一行程內第二次取鎖之訊息為「本行程已持有此鎖…」(HELD 登記表判 self);「另一個執行中（pid」只在持鎖者為他行程時出現,
//   故 §7-2 之「日誌含『略過本輪：另一個執行中（pid』」以真子行程持鎖驗證(同行程案驗「略過本輪：本行程已持有此鎖」)
// 執行:npx mocha --no-parallel test/unit-default-impl.test.mjs --timeout 180000(暫存落 test/_tmp/default-impl-<pid>,測完即刪)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mock } from 'node:test'
import genClockTZ from 'wsemi/src/genClockTZ.mjs'
import WDataPipeline from '../src/WDataPipeline.mjs'
import * as lockMod from '../src/lock/executionLock.mjs'
import * as deadlineMod from '../src/budget/deadline.mjs'
import * as budgetMod from '../src/budget/budget.mjs'
import * as loggerMod from '../src/log/runLogger.mjs'

const { definePipeline, runPipeline, acquireLock, inspectLock, deadlineMsOf, budgetOf, createLogger } = WDataPipeline

const TMP = path.resolve(`test/_tmp/default-impl-${process.pid}`).replace(/\\/g, '/') // 帶 pid 後綴使並行之多個 mocha 行程互不干擾;after 清除
const clock = genClockTZ('Asia/Taipei')

//子行程:取鎖後印一行結果並持鎖,至 stdin 關閉才釋放(模擬「另一個行程正在執行」)
const HOLDER = `
import { acquireLock } from ${JSON.stringify(pathToFileURL(path.resolve('src/lock/executionLock.mjs')).href)}
const r = acquireLock(process.env.DEFAULT_IMPL_LOCK_FILE, { staleMs: 60000 })
process.stdout.write(JSON.stringify({ ok: r.ok, message: r.message, pid: process.pid }) + '\\n')
if (r.ok) {
    process.stdin.resume()
    process.stdin.on('end', () => { r.release(); process.exit(0) })
}
`

//啟動持鎖子行程,回傳 { child, info(取鎖結果), stop():關閉 stdin 並等其結束 }
function startHolder(lockFile) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], {
            env: { ...process.env, DEFAULT_IMPL_LOCK_FILE: lockFile },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        })
        let out = ''
        let err = ''
        let got = false
        const exited = new Promise((resolve) => child.on('exit', resolve))
        child.stderr.on('data', (d) => {
            err += d
        })
        child.stdout.on('data', (d) => {
            out += d
            if (!got && out.includes('\n')) {
                got = true
                resolve({
                    child,
                    info: JSON.parse(out.split('\n')[0]),
                    stop: async () => {
                        child.stdin.end()
                        await exited
                    },
                })
            }
        })
        child.on('exit', (code) => {
            if (!got) reject(new Error(`持鎖子行程未回報即結束 code=${code} stderr=${err}`))
        })
    })
}

describe('unit-default-impl', function() {

    let n = 0
    let lockFile = ''
    let logDir = ''

    before(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
        fs.mkdirSync(TMP, { recursive: true })
    })

    after(function() {
        fs.rmSync(TMP, { recursive: true, force: true })
    })

    beforeEach(function() {
        n++
        lockFile = `${TMP}/case-${n}/run.lock`
        logDir = `${TMP}/case-${n}/log`
    })

    //管道:鎖、截止、日誌皆用套件預設實作(日誌名帶 tag 使同秒多次不共檔)
    const mk = (name, stages, tag) => {
        const lg = createLogger(tag, { dir: logDir, clock, echo: false })
        const p = definePipeline({
            name,
            stages,
            lock: () => acquireLock(lockFile, { staleMs: 60_000 }),
            deadlineMs: deadlineMsOf(20),
            log: lg,
        })
        return { p, lg }
    }
    const text = (lg) => fs.readFileSync(lg.file, 'utf8')

    describe('單一實作:主入口與深層路徑為同一份', function() {

        it('主入口物件之 11 個名稱與各模組具名匯出為同一引用(未複製、未包裝)', () => {
            for (const [mod, names] of [
                [lockMod, ['acquireLock', 'inspectLock']],
                [deadlineMod, ['deadlineMsOf', 'parseIsoDuration', 'DEADLINE_MARGIN_MS', 'DEADLINE_FLOOR_MS']],
                [budgetMod, ['budgetOf', 'reserveOf', 'reserveMsOf']],
                [loggerMod, ['createRunLogger', 'createLogger']],
            ]) {
                for (const k of names) {
                    assert.ok(k in mod, `${k} 為模組具名匯出`)
                    assert.equal(WDataPipeline[k], mod[k], `${k} 主入口與模組同一引用`)
                }
            }
        })

        it('經主入口取得之鎖,深層路徑之 inspectLock／acquireLock 亦視為本行程持有(登記表 HELD 只有一份)', () => {
            const file = `${TMP}/single/run.lock`
            const a = acquireLock(file, { staleMs: 60_000 })
            assert.equal(a.ok, true)
            assert.equal(lockMod.inspectLock(file).state, 'self', '深層路徑之 inspectLock 認得主入口取得之鎖')
            assert.equal(inspectLock(file).state, 'self')
            const b = lockMod.acquireLock(file, { staleMs: 60_000 })
            assert.equal(b.ok, false, '深層路徑之 acquireLock 不得再取同一把鎖(兩份實作會互判殘留而接管)')
            assert.match(b.message, /^本行程已持有此鎖（.+）：同一行程內不可重複取得$/)
            a.release()
            assert.equal(lockMod.inspectLock(file).state, 'none')
        })
    })

    describe('同行程雙取(建議檔 §7-3)', function() {

        it('同一行程內兩個 acquireLock(同一檔):第二個 ok:false 且 message 含「本行程已持有此鎖」;release 後可再取得', () => {
            const file = `${TMP}/double/run.lock`
            const a = acquireLock(file, { staleMs: 60_000 })
            assert.equal(a.ok, true)
            const b = acquireLock(file, { staleMs: 60_000 })
            assert.equal(b.ok, false)
            assert.ok(b.message.includes('本行程已持有此鎖'), b.message)
            a.release()
            const c = acquireLock(file, { staleMs: 60_000 })
            assert.equal(c.ok, true, 'release 後可再取得')
            c.release()
            assert.ok(!fs.existsSync(file))
        })
    })

    describe('definePipeline 搭配預設實作(建議檔 §7-2)', function() {

        it('同行程連跑兩次(第二次於第一次持鎖期間):第二次 lockSkipped === true、日誌含「略過本輪：本行程已持有此鎖」;第一次不受影響;結束後鎖檔已刪、可再跑', async () => {
            let enter
            const entered = new Promise((resolve) => {
                enter = resolve
            })
            let open
            const gate = new Promise((resolve) => {
                open = resolve
            })
            const holdStage = {
                name: 'hold',
                run: async () => {
                    enter()
                    await gate
                    return 1
                },
            }
            const A = mk('job', [holdStage], 'run-a')
            const B = mk('job', [{ name: 'never', run: () => 2 }], 'run-b')

            const first = runPipeline(A.p)
            await entered // 第一次已進入階段 = 已持鎖
            assert.equal(inspectLock(lockFile).state, 'self')

            const second = await runPipeline(B.p)
            assert.equal(second.lockSkipped, true)
            assert.equal(second.ok, true, '略過本輪是正常結束而非失敗')
            assert.equal(second.stopped, true)
            assert.equal(second.stages.length, 0, '未取得鎖不執行任何階段')
            assert.match(second.stopReason, /^本行程已持有此鎖（.+）：同一行程內不可重複取得$/)
            assert.match(text(B.lg), /\] WARN {2}管道\[job\] 略過本輪：本行程已持有此鎖/)

            open()
            const r1 = await first
            assert.equal(r1.ok, true)
            assert.equal(r1.lockSkipped, false)
            assert.equal(r1.stages[0].result, 1)
            assert.ok(!fs.existsSync(lockFile), '第一次結束即釋放鎖')

            const C = mk('job', [{ name: 'again', run: () => 3 }], 'run-c')
            const third = await runPipeline(C.p)
            assert.equal(third.lockSkipped, false)
            assert.equal(third.stages[0].result, 3, '釋放後可再取得而執行')
            assert.ok(!fs.existsSync(lockFile))
        })

        it('他行程持鎖期間再跑:lockSkipped === true、日誌含「略過本輪：另一個執行中（pid <持鎖者>」;持鎖者結束後可取得', async function() {
            this.timeout(60_000)
            const holder = await startHolder(lockFile)
            try {
                assert.equal(holder.info.ok, true, '子行程取得鎖')
                assert.notEqual(holder.info.pid, process.pid)

                const B = mk('job', [{ name: 'never', run: () => 2 }], 'run-b')
                const skipped = await runPipeline(B.p)
                assert.equal(skipped.lockSkipped, true)
                assert.equal(skipped.ok, true)
                assert.equal(skipped.stopped, true)
                assert.match(skipped.stopReason, new RegExp(`^另一個執行中（pid ${holder.info.pid}，已執行 \\d+s，陳舊期限 1 分（持鎖者宣告））$`))
                assert.ok(text(B.lg).includes(`略過本輪：另一個執行中（pid ${holder.info.pid}`), text(B.lg))
                assert.match(text(B.lg), new RegExp(`\\] WARN {2}管道\\[job\\] 略過本輪：另一個執行中（pid ${holder.info.pid}`))
            }
            finally {
                await holder.stop()
            }
            assert.ok(!fs.existsSync(lockFile), '持鎖子行程結束前 release')

            const C = mk('job', [{ name: 'ran', run: () => 'ok' }], 'run-c')
            const after = await runPipeline(C.p)
            assert.equal(after.lockSkipped, false)
            assert.equal(after.stages[0].result, 'ok')
        })

        it('截止由 deadlineMsOf(20) 推導:ctx 截止期限恰為 840000ms,budgetOf(ctx).remainingMs() ≤ 840000 且隨時間遞減(假時鐘:前進 5s 恰少 5000ms);過截止即逾期', async () => {
            const seen = []
            const budgetStage = {
                name: 'budget',
                run: async (ctx) => {
                    const b = budgetOf(ctx)
                    seen.push({ span: ctx.deadlineAt - ctx.startedAt, r1: b.remainingMs(), expired: b.expired(), capped: b.capMs(10 * 3600_000) })
                    mock.timers.tick(5000)
                    seen.push({ r2: b.remainingMs(), capped: b.capMs(10 * 3600_000) })
                    mock.timers.tick(840_000) // 總計 845s > 840s
                    seen.push({ r3: b.remainingMs(), expired: b.expired(), capped: b.capMs(10 * 3600_000), stop: b.shouldStop() })
                },
            }
            const { p } = mk('job', [budgetStage], 'run-a')
            mock.timers.enable({ apis: ['Date'], now: Date.now() }) // 時間本身是規格者用假時鐘(計時器測試規格):remainingMs 隨 Date.now 遞減
            let r = null
            try {
                r = await runPipeline(p)
            }
            finally {
                mock.timers.reset()
            }
            assert.equal(r.ok, true)
            assert.equal(seen[0].span, 840_000, '截止 = deadlineMsOf(20)')
            assert.equal(seen[0].r1, 840_000, '建立 ctx 後未經時間,剩餘即整輪截止')
            assert.equal(seen[0].expired, false)
            assert.equal(seen[0].capped, 840_000, 'capMs 以剩餘封頂')
            assert.equal(seen[1].r2, 835_000, '前進 5s → 剩餘少 5000ms(隨時間遞減)')
            assert.equal(seen[1].capped, 835_000)
            assert.equal(seen[2].r3, 0, '逾截止後剩餘夾 0')
            assert.equal(seen[2].expired, true)
            assert.equal(seen[2].stop, true)
            assert.equal(seen[2].capped, 1, '逾期後 capMs 仍回 1')
        })

        it('日誌以套件預設格式落檔:階段行為「[<ISO>] INFO  步驟1 …」、起訖行同格式;檔名 {dir}/{day}/{stamp}-{name}.log', async () => {
            const { p, lg } = mk('job', [{ name: 'a', run: () => ({ summary: '三筆' }) }, { name: 'b', run: () => 1 }], 'run-a')
            const r = await runPipeline(p)
            assert.equal(r.ok, true)
            const t = text(lg)
            assert.match(t, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] INFO {2}管道\[job\] 啟動（2 段）$/m)
            assert.match(t, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] INFO {2}步驟1 a 完成：三筆（\d+\.\ds）$/m)
            assert.match(t, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] INFO {2}步驟2 b 完成（\d+\.\ds）$/m)
            assert.match(t, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] INFO {2}管道\[job\] 結束，耗時 \d+\.\ds$/m)
            assert.equal(path.basename(lg.file), `${lg.now}-run-a.log`)
            assert.equal(path.basename(path.dirname(lg.file)), lg.now.slice(0, 8))
        })

        it('階段失敗時仍釋放鎖(finally):下一輪可取得', async () => {
            const boomStage = {
                name: 'boom',
                run: () => {
                    throw new Error('壞了')
                },
            }
            const { p } = mk('job', [boomStage], 'run-a')
            const r = await runPipeline(p)
            assert.equal(r.ok, false)
            assert.ok(!fs.existsSync(lockFile), '失敗後鎖檔已刪')
            const again = acquireLock(lockFile, { staleMs: 60_000 })
            assert.equal(again.ok, true)
            again.release()
        })

        it('外部仍可注入自有實作:自有 lock({acquire})與自有 log({info,warn,error})介面不變', async () => {
            const lines = []
            const log = { info: (m) => lines.push(`I ${m}`), warn: (m) => lines.push(`W ${m}`), error: (m) => lines.push(`E ${m}`) }
            const p = definePipeline({
                name: 'own',
                stages: [{ name: 's', run: () => 1 }],
                lock: { acquire: () => ({ ok: false, message: '自有鎖占用中' }) },
                log,
            })
            const r = await runPipeline(p)
            assert.equal(r.lockSkipped, true)
            assert.equal(r.stopReason, '自有鎖占用中')
            assert.ok(lines.includes('W 管道[own] 略過本輪：自有鎖占用中'), lines.join('|'))
        })
    })

})
