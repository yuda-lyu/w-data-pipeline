// unit-deadline.test.mjs — 由排程上限推導整輪截止:parseIsoDuration、deadlineMsOf(邊際、下限、取整、參數覆寫)
// 來源:自 srcRunner(w-task-runner)test/unit-deadline.test.mjs(5 案)逐字移植,輸入與期望值不變,只改 import 與函數所在;it 標題前綴標原檔行號
// 執行:npx mocha --no-parallel test/unit-deadline.test.mjs --timeout 180000

import assert from 'node:assert/strict'
import { parseIsoDuration, deadlineMsOf, DEADLINE_MARGIN_MS, DEADLINE_FLOOR_MS } from '../src/budget/deadline.mjs'

describe('unit-deadline', function() {

    it('[unit-deadline:9] parseIsoDuration:時、分、秒三段皆認(PT1H30M 不可解成 30 分);寫錯即拋錯且訊息含原值', () => {
        assert.equal(parseIsoDuration('PT20M'), 20)
        assert.equal(parseIsoDuration('PT55M'), 55)
        assert.equal(parseIsoDuration('PT1H30M'), 90)
        assert.equal(parseIsoDuration('PT90S'), 1.5)
        assert.equal(parseIsoDuration('PT2H'), 120)
        for (const bad of ['', 'PT', '20M', 'P1D', 'PT1.5M', 'pt20m', null, undefined, 20]) {
            assert.throws(() => parseIsoDuration(bad), /須為 ISO-8601 時距（如 PT55M、PT1H30M），收到：/, JSON.stringify(bad))
        }
    })

    it('[unit-deadline:20] deadlineMsOf:截止＝max(下限 10 分, 上限 − 6 分);整數分鐘之代表值', () => {
        assert.deepEqual([DEADLINE_MARGIN_MS, DEADLINE_FLOOR_MS], [360_000, 600_000])
        assert.equal(deadlineMsOf(20), 840_000)
        assert.equal(deadlineMsOf(55), 2_940_000)
        assert.equal(deadlineMsOf(5), 600_000, '下限')
        assert.equal(deadlineMsOf(10), 600_000, '上限 10 分減邊際為 4 分 → 取下限')
        assert.equal(deadlineMsOf(0), 600_000, '0 亦取下限(不拋)')
    })

    it('[unit-deadline:29] deadlineMsOf:回傳一律為正整數(非整數分鐘亦然)', () => {
        for (const m of [1.5, 20.0001, 7 / 60, 55.333333]) {
            const v = deadlineMsOf(m)
            assert.ok(Number.isInteger(v) && v > 0, `${m} → ${v}`)
        }
        assert.equal(deadlineMsOf(20.0001), 840_006)
    })

    it('[unit-deadline:37] deadlineMsOf:opt 覆寫邊際與下限;無效值回退預設;opt 非物件視為 {}', () => {
        assert.equal(deadlineMsOf(20, { marginMs: 60_000 }), 1_140_000)
        assert.equal(deadlineMsOf(20, { marginMs: 0 }), 1_200_000, '邊際可為 0')
        assert.equal(deadlineMsOf(5, { floorMs: 120_000 }), 120_000)
        assert.equal(deadlineMsOf(20, { marginMs: -1, floorMs: 0 }), 840_000, '無效值回退預設')
        assert.equal(deadlineMsOf(20, 'bad'), 840_000)
        assert.equal(deadlineMsOf(20, null), 840_000)
    })

    it('[unit-deadline:46] deadlineMsOf:limitMin 非非負有限數即拋錯', () => {
        for (const bad of [-1, NaN, Infinity, '20', null, undefined]) {
            assert.throws(() => deadlineMsOf(bad), /deadlineMsOf 需要非負之排程上限分鐘數/, String(bad))
        }
    })

})
