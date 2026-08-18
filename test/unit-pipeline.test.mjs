import assert from 'assert'
import WDataPipeline from '../src/WDataPipeline.mjs'


let { definePipeline, runPipeline, defineStage, ContractError, PipelineError } = WDataPipeline

//delay
let delay = (ms) => new Promise((r) => setTimeout(r, ms))


describe('pipeline', function() {

    describe('定義期契約檢查', function() {

        it('管道缺 name 拋 ContractError', function() {
            assert.throws(() => definePipeline({ stages: [{ name: 'a', run: () => {} }] }), ContractError)
        })

        it('stages 空陣列拋 ContractError', function() {
            assert.throws(() => definePipeline({ name: 'p', stages: [] }), ContractError)
        })

        it('階段名重複拋 ContractError', function() {
            assert.throws(() => definePipeline({
                name: 'p',
                stages: [
                    { name: 'a', run: () => {} },
                    { name: 'a', run: () => {} },
                ],
            }), ContractError)
        })

        it('階段缺 run 拋 ContractError', function() {
            assert.throws(() => defineStage({ name: 'a' }), ContractError)
        })

        it('onError 打錯字拋 ContractError', function() {
            assert.throws(() => defineStage({ name: 'a', run: () => {}, onError: 'ignore' }), ContractError)
        })

        it('timeoutMs 非整數拋 ContractError', function() {
            assert.throws(() => defineStage({ name: 'a', run: () => {}, timeoutMs: 1.5 }), ContractError)
        })

    })

    describe('執行秩序', function() {

        it('依序執行, 回傳值進 ctx.prev, 報告逐段記錄', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => 10 },
                    { name: 's2', run: (ctx) => ctx.prev + 5 },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stages.length, 2)
            assert.strictEqual(r.stages[0].status, 'ok')
            assert.strictEqual(r.stages[1].status, 'ok')
            assert.strictEqual(r.stages[1].result, 15)
        })

        it('bag 跨段共享(ctx.set/get)', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: (ctx) => ctx.set('k', 'v') },
                    { name: 's2', run: (ctx) => ctx.get('k') },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.stages[1].result, 'v')
        })

        it('when 回 false 即跳過', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => 1, when: () => false },
                    { name: 's2', run: () => 2 },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stages[0].status, 'skip')
            assert.strictEqual(r.stages[1].status, 'ok')
        })

        it('stop 停止後續段, always 段仍執行', async function() {
            let ranAlways = false
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => ({ stop: true, reason: '無新資料' }) },
                    { name: 's2', run: () => 2 },
                    { name: 'fin', always: true, run: () => { ranAlways = true } },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stopped, true)
            assert.strictEqual(r.stopReason, '無新資料')
            assert.strictEqual(r.stages[1].status, 'skip')
            assert.strictEqual(r.stages[2].status, 'ok')
            assert.strictEqual(ranAlways, true)
        })

    })

    describe('失敗隔離', function() {

        it('onError:continue 失敗只記警告並續跑, 管道仍算成功', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => { throw new Error('boom') }, onError: 'continue' },
                    { name: 's2', run: () => 2 },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stages[0].status, 'fail')
            assert.strictEqual(r.stages[1].status, 'ok')
        })

        it('onError:abort(預設) 中止後續段, always 段仍執行, 錯誤為 StageError', async function() {
            let ranAlways = false
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => { throw new Error('boom') } },
                    { name: 's2', run: () => 2 },
                    { name: 'fin', always: true, run: () => { ranAlways = true } },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, false)
            assert.strictEqual(r.aborted, true)
            assert.strictEqual(r.error?.code, 'STAGE')
            assert.strictEqual(r.stages[1].status, 'skip')
            assert.strictEqual(ranAlways, true)
        })

        it('收尾段自己也失敗時不覆蓋根因, 進 cleanupErrors', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => { throw new Error('根因') } },
                    { name: 'fin', always: true, run: () => { throw new Error('收尾也倒') } },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, false)
            assert.ok(r.error.message.includes('根因'))
            assert.strictEqual(r.cleanupErrors.length, 1)
            assert.ok(r.cleanupErrors[0].message.includes('收尾也倒'))
        })

        it('階段逾時 reason 為 timeout', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 'slow', run: () => delay(300), timeoutMs: 30 },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, false)
            assert.strictEqual(r.stages[0].status, 'fail')
            assert.strictEqual(r.stages[0].reason, 'timeout')
        })

        it('timeoutMs:0 代表不設限, 不會下一輪事件迴圈即逾時', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [
                    { name: 's1', run: () => delay(30).then(() => 'done'), timeoutMs: 0 },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stages[0].result, 'done')
        })

    })

    describe('巢狀管道', function() {

        it('子管道失敗 × 父層 onError:continue → 父層成功, 且父報告保留子管道逐段明細', async function() {
            let child = definePipeline({
                name: 'child',
                onError: 'continue',
                stages: [
                    { name: 'c1', run: () => 1 },
                    { name: 'c2', run: () => { throw new Error('子段倒了') } },
                ],
            })
            let parent = definePipeline({
                name: 'parent',
                stages: [
                    child,
                    { name: 'p2', run: () => 2 },
                ],
            })
            let r = await runPipeline(parent)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stages[0].status, 'fail')
            //子管道完整 report 保留於 rec.result, 巡檢與事後歸因不斷線
            assert.strictEqual(r.stages[0].result?.name, 'child')
            assert.strictEqual(r.stages[0].result?.stages?.[1]?.status, 'fail')
            assert.strictEqual(r.stages[1].status, 'ok')
        })

        it('子管道失敗 × 父層預設 abort → 父層失敗', async function() {
            let child = definePipeline({
                name: 'child',
                stages: [{ name: 'c1', run: () => { throw new Error('boom') } }],
            })
            let parent = definePipeline({
                name: 'parent',
                stages: [child, { name: 'p2', run: () => 2 }],
            })
            let r = await runPipeline(parent)
            assert.strictEqual(r.ok, false)
            assert.strictEqual(r.stages[1].status, 'skip')
        })

        it('子段宣告 onError:continue 不使子管道失敗', async function() {
            let child = definePipeline({
                name: 'child',
                stages: [
                    { name: 'c1', run: () => { throw new Error('可容忍') }, onError: 'continue' },
                    { name: 'c2', run: () => 2 },
                ],
            })
            let parent = definePipeline({
                name: 'parent',
                stages: [child],
            })
            let r = await runPipeline(parent)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stages[0].status, 'ok')
        })

        it('run() 入口於失敗時拋 PipelineError 且完整 report 掛在 e.report', async function() {
            let child = definePipeline({
                name: 'child',
                stages: [{ name: 'c1', run: () => { throw new Error('boom') } }],
            })
            await assert.rejects(async () => child.run(), (e) => {
                assert.ok(e instanceof PipelineError)
                assert.strictEqual(e.report?.ok, false)
                assert.strictEqual(e.report?.stages?.[0]?.status, 'fail')
                return true
            })
        })

        it('stop 不跨管道傳播: 子管道提前收工, 父管道續跑下一段', async function() {
            let child = definePipeline({
                name: 'child',
                stages: [{ name: 'c1', run: () => ({ stop: true, reason: '子輪收工' }) }],
            })
            let parent = definePipeline({
                name: 'parent',
                stages: [child, { name: 'p2', run: () => 'p2 照跑' }],
            })
            let r = await runPipeline(parent)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.stopped, false)
            assert.strictEqual(r.stages[1].result, 'p2 照跑')
        })

        it('時間預算取父子較嚴者: 子管道未宣告 deadlineMs 時繼承父層剩餘時間', async function() {
            let seen = null
            let child = definePipeline({
                name: 'child',
                stages: [{ name: 'c1', run: (ctx) => { seen = ctx.remainingMs() } }],
            })
            let parent = definePipeline({
                name: 'parent',
                deadlineMs: 5000,
                stages: [child],
            })
            let r = await runPipeline(parent)
            assert.strictEqual(r.ok, true)
            assert.ok(Number.isFinite(seen), `子管道內 remainingMs 應為有限值, 實得 ${seen}`)
            assert.ok(seen <= 5000)
        })

        it('逾時間預算後續段跳過, always 段不受限', async function() {
            let ranAlways = false
            let p = definePipeline({
                name: 'p',
                deadlineMs: 10,
                stages: [
                    { name: 's1', run: () => delay(50) },
                    { name: 's2', run: () => 2 },
                    { name: 'fin', always: true, run: () => { ranAlways = true } },
                ],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.stages[1].status, 'skip')
            assert.strictEqual(r.stages[1].reason, '逾時間預算')
            assert.strictEqual(ranAlways, true)
        })

    })

    describe('執行鎖', function() {

        it('未取得鎖: 略過本輪但非失敗', async function() {
            let ran = false
            let p = definePipeline({
                name: 'p',
                lock: () => ({ ok: false, message: '上一輪還在跑' }),
                stages: [{ name: 's1', run: () => { ran = true } }],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true)
            assert.strictEqual(r.lockSkipped, true)
            assert.strictEqual(r.stopped, true)
            assert.strictEqual(ran, false)
        })

        it('取鎖本身故障(拋錯): 屬失敗而非正常略過', async function() {
            let p = definePipeline({
                name: 'p',
                lock: () => { throw new Error('磁碟故障') },
                stages: [{ name: 's1', run: () => 1 }],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, false)
            assert.strictEqual(r.lockSkipped, false)
            assert.strictEqual(r.aborted, true)
        })

        it('非同步 release 於 runPipeline 返回前完成', async function() {
            let released = false
            let p = definePipeline({
                name: 'p',
                lock: () => ({
                    ok: true,
                    release: async () => {
                        await delay(30)
                        released = true
                    },
                }),
                stages: [{ name: 's1', run: () => 1 }],
            })
            await runPipeline(p)
            assert.strictEqual(released, true)
        })

        it('onStart 拋錯不洩漏鎖(release 仍被呼叫)', async function() {
            let released = false
            let p = definePipeline({
                name: 'p',
                lock: () => ({ ok: true, release: () => { released = true } }),
                onStart: () => { throw new Error('日誌鉤子壞了') },
                stages: [{ name: 's1', run: () => 1 }],
            })
            let r = await runPipeline(p)
            assert.strictEqual(r.ok, true) //鉤子拋錯不承擔成敗
            assert.strictEqual(released, true)
        })

    })

    describe('生命週期鉤子', function() {

        it('onStart/onStageEnd/onEnd 皆被 await(非同步鉤子完成後才返回)', async function() {
            let calls = []
            let hook = (tag) => async () => {
                await delay(20)
                calls.push(tag)
            }
            let p = definePipeline({
                name: 'p',
                onStart: hook('start'),
                onStageEnd: hook('stageEnd'),
                onEnd: hook('end'),
                stages: [{ name: 's1', run: () => 1 }],
            })
            await runPipeline(p)
            assert.deepStrictEqual(calls, ['start', 'stageEnd', 'end'])
        })

    })

    describe('頂層入口', function() {

        it('runPipeline 一律回傳 report 不拋(失敗檢查 report.ok)', async function() {
            let p = definePipeline({
                name: 'p',
                stages: [{ name: 's1', run: () => { throw new Error('boom') } }],
            })
            let r = await runPipeline(p) //不應拋出
            assert.strictEqual(r.ok, false)
        })

        it('runPipeline 收到非 definePipeline/defineStage 產出拋 ContractError', async function() {
            await assert.rejects(async () => runPipeline({}), ContractError)
        })

        it('runPipeline 可直接執行單一階段(defineStage 之產出)', async function() {
            let st = defineStage({ name: 's1', run: () => 'ok' })
            let r = await runPipeline(st)
            assert.strictEqual(r, 'ok')
        })

    })

})
