// unit-budget.test.mjs — 時間預算單一擁有者(src/budget/budget):各段只消費 budgetOf(ctx),不各自持有數字;選配段之子預算(reserveOf)與保留時間之取值器(reserveMsOf)
// 來源:自執行殼(w-task-runner)test/unit-budget.test.mjs(7 案)逐字移植,輸入與期望值不變,只改 import 與函數所在;it 標題前綴標原檔行號
// 執行:npx mocha --no-parallel test/unit-budget.test.mjs --timeout 180000

import assert from 'node:assert/strict'
import { budgetOf, reserveOf, reserveMsOf } from '../src/budget/budget.mjs'


describe('unit-budget', function() {

    it('[unit-budget:10] 無截止(ctx 無 remainingMs)：剩餘無限、不逾期、封頂原樣回傳、席位不動', () => {
        const b = budgetOf({})
        assert.equal(b.remainingMs(), Infinity)
        assert.equal(b.expired(), false)
        assert.equal(b.shouldStop(), false)
        assert.equal(b.capMs(5000), 5000)
        assert.equal(b.capMs(Infinity), Infinity, '無截止時交給呼叫端的預設(dispatchAiFallback 自算鏈總和)')
        const seat = { use: 'x', budgetMs: 1234 }
        assert.equal(b.capSeat(seat), seat, '無截止不包裝席位(原物件)')
        assert.equal(budgetOf(null).remainingMs(), Infinity, 'ctx 缺席亦不拋')
    })

    it('[unit-budget:22] 有截止：capMs 取 min(要求, 剩餘)、下限 1ms;NaN 之剩餘視為無限', () => {
        let left = 5000
        const b = budgetOf({ remainingMs: () => left, expired: () => left <= 0 })
        assert.equal(b.remainingMs(), 5000)
        assert.equal(b.capMs(10_000), 5000)
        assert.equal(b.capMs(3000), 3000)
        assert.equal(b.capMs(Infinity), 5000, '無要求即以剩餘為上限')
        assert.equal(b.capMs(0), 5000, '非正數之要求視為無要求')
        left = 0
        assert.equal(b.capMs(3000), 1, '逾期後仍回 1ms(呼叫端以 shouldStop 守門,不靠 0 預算)')
        assert.equal(b.expired(), true)
        assert.equal(b.shouldStop(), true, 'shouldStop 即 expired(w-dispatch-ai 於嘗試之間詢問)')
        left = -100
        assert.equal(b.remainingMs(), 0, '負值夾為 0')
        left = NaN
        assert.equal(b.remainingMs(), Infinity)
        assert.equal(b.capMs(7000), 7000)
    })

    it('[unit-budget:41] capSeat：budgetMs 為 getter,於席位「開工當下」(被展開時)才求值——序列後段席位拿到當時的剩餘', () => {
        let left = 8000
        const b = budgetOf({ remainingMs: () => left, expired: () => left <= 0 })
        const seat = { use: 'a', fallback: ['b'], budgetMs: 10_000 }
        const s = b.capSeat(seat)
        assert.notEqual(s, seat, '不改原席位')
        assert.deepEqual(Object.keys(s).sort(), ['budgetMs', 'fallback', 'use'], 'getter 可列舉——工作流以 spread 展開席位時不得消失')
        assert.equal(s.budgetMs, 8000, '開工時剩餘 8s < 席位 10s → 封頂 8s')
        left = 2000
        assert.equal({ ...s }.budgetMs, 2000, '數十分鐘後才輪到的席位,展開時取到當下剩餘(複審 B3)')
        left = 20_000
        assert.equal({ ...s }.budgetMs, 10_000, '剩餘充裕時維持席位自身預算')
        const noBudget = b.capSeat({ use: 'c' })
        assert.equal(noBudget.budgetMs, 20_000, '席位未給預算者以剩餘為預算')
        assert.equal(b.capSeat(null), null)
        assert.equal(b.capSeat('str'), 'str')
    })

    describe('reserveOf(選配段之子預算:扣掉保留給後段之時間)', function() {

        it('[unit-budget:61] 有截止:剩餘＝整輪剩餘−保留;canStart 依門檻與是否逾期', () => {
            let left = 2_000_000
            const b = reserveOf({ remainingMs: () => left, expired: () => left <= 0 }, 900_000)
            assert.equal(b.remainingMs(), 1_100_000)
            assert.equal(b.canStart(240_000), true)
            assert.equal(b.shouldStop(240_000), false)
            assert.equal(b.canStart(1_200_000), false, '扣保留後不足門檻即不開工')
            left = 800_000
            assert.equal(b.remainingMs(), 0, '剩餘不及保留者夾為 0(不得吃進後段)')
            assert.equal(b.canStart(1), false)
            left = 0
            assert.equal(b.shouldStop(0), true, '整輪逾期即停')
        })

        it('[unit-budget:75] 無截止或保留非正數:剩餘無限、保留視為 0', () => {
            assert.equal(reserveOf({}, 900_000).remainingMs(), Infinity)
            assert.equal(reserveOf(null, 5).canStart(10 ** 12), true)
            const b = reserveOf({ remainingMs: () => 5000, expired: () => false }, -3)
            assert.equal(b.remainingMs(), 5000)
            assert.equal(reserveOf({ remainingMs: () => 5000, expired: () => false }, NaN).remainingMs(), 5000)
            assert.equal(reserveOf({ remainingMs: () => 5000, expired: () => false }, 0).remainingMs(), budgetOf({ remainingMs: () => 5000 }).remainingMs())
        })

        it('[unit-budget:84] reserveMsOf:數字或 (ctx)=>數字 → (ctx)=>數字;未給為 0;不合即拋(建構時或呼叫時),訊息帶出處', () => {
            assert.equal(reserveMsOf(900_000)(null), 900_000)
            assert.equal(reserveMsOf(0)(null), 0)
            assert.equal(reserveMsOf(undefined)(null), 0)
            assert.equal(reserveMsOf(null)({}), 0)
            assert.equal(reserveMsOf((ctx) => ctx.n * 2)({ n: 5 }), 10, '函數於每次呼叫依 ctx 求值')
            assert.throws(() => reserveMsOf(-1, 'stageX 之 opt.reserveMs'), /^Error: stageX 之 opt\.reserveMs 須為非負毫秒數或 \(ctx\) => 毫秒數，收到 -1$/)
            assert.throws(() => reserveMsOf('900'), /reserveMs 須為非負毫秒數/, '字串不收(不隱性轉型)')
            assert.throws(() => reserveMsOf(NaN), /收到 NaN/)
            const f = reserveMsOf(() => -5, 'deps.reserveMs')
            assert.throws(() => f({}), /^Error: deps\.reserveMs 函數須回傳非負毫秒數，收到 -5$/, '函數回傳不合者於呼叫時拋')
        })
    })

})
