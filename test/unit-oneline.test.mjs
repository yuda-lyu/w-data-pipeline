// unit-oneline.test.mjs — src/util/oneline:壓成單行並限長;n 由本函數自行以 wsemi iseint(count)檢查,有效才轉數字交 strTruncate,非有效值不截斷
// spec 來源:①src/util/oneline.mjs JSDoc(壓平空白;n 有效且超長補刪節號、未超長原樣;非有效值不截斷;n 預設 200)
//          ②主控 r3pl 派工(wsemi 第 3 輪前,下游先行:改前改後輸出逐字相同;strTruncate 嚴格版〔maxLen 必須且為 count〕下不拋錯)
// 執行:npx mocha --no-parallel test/unit-oneline.test.mjs --timeout 180000

/* eslint-disable no-new-wrappers -- 包裝物件(new Number／String／Boolean)正是被測的非有效 n 之一 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { oneline } from '../src/util/oneline.mjs'
import { legacyOneline } from './tools/legacyOneline.mjs'
import strTruncateStrict, { calls, loadWithStrictStrTruncate } from './tools/strictWsemi.mjs'

const SRC = fileURLToPath(new URL('../src/util/oneline.mjs', import.meta.url))

// 未給 n(走預設 200)
const UNSET = Symbol('unset')
const call = (fn, s, n) => (n === UNSET ? fn(s) : fn(s, n))

// 壓平後整行 314 字:'ab cd ef gh'(11)+ 300 個 x + ' 尾端'(3)
const LONG = 'ab\ncd\t\tef   gh' + 'x'.repeat(300) + '\r\n尾端'
const LONG_LINE = 'ab cd ef gh' + 'x'.repeat(300) + ' 尾端'

// 輸入字串空間:[鍵, 輸入, 壓平後之整行]
const S_CASES = [
    ['long', LONG, LONG_LINE],
    ['short', 'abc', 'abc'],
    ['exact5', '12345', '12345'],
    ['six', '123456', '123456'],
    ['empty', '', ''],
    ['blanks', '   \n\t ', ''],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['number', 1234567, '1234567'],
    ['object', {
        toString() {
            return 'obj-to-string-long-text'
        }
    }, 'obj-to-string-long-text'],
    ['error', new Error('boom\nline2'), 'Error: boom line2'],
    ['cjk', '中文字串測試多行\n第二行', '中文字串測試多行 第二行'],
    ['emoji', 'ab😀😀😀cd', 'ab😀😀😀cd'],
]

// n 之有效值:[標籤, 值, 截斷長度 k(對 LONG_LINE:k < 314 則取前 k 字補 '...',否則整行)]
const N_VALID = [
    ['未給(預設 200)', UNSET, 200],
    ['undefined(預設 200)', undefined, 200],
    ['0', 0, 0],
    ['-0', -0, 0],
    ['1', 1, 1],
    ['3', 3, 3],
    ['5', 5, 5],
    ['40', 40, 40],
    ['120', 120, 120],
    ['200', 200, 200],
    ['300', 300, 300],
    ['500(大於整行)', 500, 500],
    ['100000', 100000, 100000],
    ['2147483648', 2 ** 31, 2 ** 31],
    ['4294967295(count 上限)', 4294967295, 4294967295],
    [`'200'`, '200', 200],
    [`'5'`, '5', 5],
    [`' 5 '`, ' 5 ', 5],
    [`'5.0'`, '5.0', 5],
    [`'1.5e1'`, '1.5e1', 15],
    [`'5e0'`, '5e0', 5],
    [`'007'`, '007', 7],
    [`'+5'`, '+5', 5],
    [`'4294967295'`, '4294967295', 4294967295],
]

// n 之非有效值:不截斷,回壓平後整行
const N_INVALID = [
    ['null', null],
    ['-1', -1],
    [`'-1'`, '-1'],
    ['1.5', 1.5],
    [`'1.5'`, '1.5'],
    ['0.4', 0.4],
    ['2.5', 2.5],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    [`'Infinity'`, 'Infinity'],
    [`'NaN'`, 'NaN'],
    [`'abc'`, 'abc'],
    [`''`, ''],
    [`' '`, ' '],
    [`'1,000'`, '1,000'],
    ['true', true],
    ['false', false],
    ['[]', []],
    ['[5]', [5]],
    ['{}', {}],
    ['{valueOf:5}', {
        valueOf() {
            return 5
        }
    }],
    ['5n(BigInt)', 5n],
    ['函數', () => 5],
    ['Date', new Date(5)],
    ['Symbol', Symbol('x')],
    ['new Boolean(true)', new Boolean(true)],
    ['4294967296(逾 count 上限)', 4294967296],
    [`'4294967296'`, '4294967296'],
    ['2**53(非安全整數)', 2 ** 53],
    ['2**53+2', 2 ** 53 + 2],
    [`'9007199254740993'(精度遺失)`, '9007199254740993'],
    ['1e21', 1e21],
    ['Number.MAX_VALUE', Number.MAX_VALUE],
]

// 改前因 wsemi isint 之寬鬆(包裝物件解包、0x/0b 前綴字串)而「碰巧」截斷、但依 iseint(count) 與 JSDoc「非有效值則不截斷」屬無效者;[標籤, 值, 改前截斷長度]
const N_LEGACY_LENIENT = [
    [`'0x10'(十六進位字串)`, '0x10', 16],
    [`'0b11'(二進位字串)`, '0b11', 3],
    ['new Number(5)(包裝物件)', new Number(5), 5],
    [`new String('5')(包裝物件)`, new String('5'), 5],
]

const trunc = (line, k) => (line.length > k ? line.slice(0, k) + '...' : line)


describe('unit-oneline', function() {

    describe('壓平空白(JSDoc:壓成單行,與 n 無關)', function() {

        it('[unit-oneline:1] 連續空白／換行／tab 壓成單一空格並去頭尾;null／undefined 為空字串;非字串先轉字串', () => {
            assert.equal(oneline('a\n b\t\tc  d'), 'a b c d')
            assert.equal(oneline('  x  '), 'x')
            assert.equal(oneline('line1\r\nline2\n\nline3'), 'line1 line2 line3')
            for (const [k, s, line] of S_CASES) {
                assert.equal(oneline(s, 100000), line, `輸入 ${k}`)
            }
        })

        it('[unit-oneline:2] 先壓平再計長:壓平後未超長者原樣、超長者截斷後仍為單行(日誌單筆不散成多行)', () => {
            assert.equal(oneline('a\n\n\nb', 3), 'a b', '壓平後 3 字 ≤ n=3 → 不截斷、不補刪節號')
            assert.equal(oneline('a\n\n\nb', 2), 'a ...', '壓平後 3 字 > n=2 → 取前 2 字補刪節號')
            assert.doesNotMatch(oneline(LONG, 50), /[\r\n\t]/)
            assert.doesNotMatch(oneline(LONG, 'abc'), /[\r\n\t]/, '非有效 n:不截斷但仍壓平')
        })
    })

    describe('n 為有效值(iseint count):超長截斷補刪節號、未超長原樣', function() {

        for (const [label, n, k] of N_VALID) {
            it(`[unit-oneline:3] n=${label}:` + (k >= 314 ? '未超長,整行原樣' : `長輸入取前 ${k} 字補 ...`), () => {
                assert.equal(call(oneline, LONG, n), trunc(LONG_LINE, k))
            })
        }

        it('[unit-oneline:4] n 預設 200:壓平後 314 字 → 前 200 字 + "..."(共 203);200 字內原樣', () => {
            const r = oneline(LONG)
            assert.equal(r.length, 203)
            assert.equal(r, LONG_LINE.slice(0, 200) + '...')
            assert.equal(oneline('x'.repeat(200)), 'x'.repeat(200))
            assert.equal(oneline('x'.repeat(201)), 'x'.repeat(200) + '...')
        })

        it('[unit-oneline:5] 邊界:長度恰等於 n 不補刪節號、n+1 才補;n=0 時非空輸入為 "...",空輸入仍為空', () => {
            assert.equal(oneline('12345', 5), '12345')
            assert.equal(oneline('123456', 5), '12345...')
            assert.equal(oneline('abc', 0), '...')
            assert.equal(oneline('', 0), '')
            assert.equal(oneline(null, 0), '')
        })

        it('[unit-oneline:6] n 為可無損轉數字之字串視為有效,與同值數字結果相同', () => {
            for (const [label, n, k] of N_VALID.filter(([, v]) => typeof v === 'string')) {
                assert.equal(oneline(LONG, n), oneline(LONG, k), `n=${label}`)
            }
        })
    })

    describe('n 為非有效值:不截斷,回壓平後整行(JSDoc;不依賴 strTruncate 對無效 maxLen 之處置)', function() {

        for (const [label, n] of [...N_INVALID, ...N_LEGACY_LENIENT.map(([l, v]) => [l, v])]) {
            it(`[unit-oneline:7] n=${label}:不截斷`, () => {
                assert.equal(oneline(LONG, n), LONG_LINE, '整行 314 字,不補刪節號')
                assert.equal(oneline('abc', n), 'abc')
                assert.equal(oneline(' a\nb ', n), 'a b', '仍壓平空白')
                assert.equal(oneline(null, n), '')
                assert.equal(oneline('', n), '')
            })
        }
    })

    describe('改前改後差分(逐字相同)', function() {

        it('[unit-oneline:8] 輸入字串空間 × n 之有效值與非有效值:新舊輸出逐字相同(差分 0)', () => {
            let compared = 0
            for (const [sk, s] of S_CASES) {
                for (const [label, n] of [...N_VALID, ...N_INVALID]) {
                    assert.equal(call(oneline, s, n), call(legacyOneline, s, n), `s=${sk} n=${label}`)
                    compared++
                }
            }
            assert.equal(compared, S_CASES.length * (N_VALID.length + N_INVALID.length))
        })

        it('[unit-oneline:9] 唯一差異:改前因 isint 寬鬆而截斷之 4 種無效 n(0x／0b 字串、Number／String 包裝物件),現依 iseint(count) 與 JSDoc 不截斷', () => {
            for (const [label, n, k] of N_LEGACY_LENIENT) {
                assert.equal(legacyOneline(LONG, n), trunc(LONG_LINE, k), `改前 n=${label} 碰巧截斷於 ${k}`)
                assert.equal(oneline(LONG, n), LONG_LINE, `現 n=${label} 不截斷`)
            }
        })
    })

    describe('wsemi strTruncate 第 3 輪嚴格版替身(maxLen 必須且為 count,未給或非預期即拋錯)', function() {

        it('[unit-oneline:10] 替身有效性:未給／非 count 之 maxLen 拋錯;有效 maxLen 同第 2 輪行為(替身若不拋錯,下列前瞻驗證即失去意義)', () => {
            assert.throws(() => strTruncateStrict('abc'), /invalid maxLen/)
            for (const bad of [undefined, null, -1, 1.5, Infinity, NaN, 'abc', '', true, [], {}, 5n, 4294967296, new Number(5)]) {
                assert.throws(() => strTruncateStrict('abc', bad), /invalid maxLen/, `maxLen=${String(bad)}`)
            }
            assert.equal(strTruncateStrict('abcdef', 3), 'abc...')
            assert.equal(strTruncateStrict('abcdef', '3'), 'abc...')
            assert.equal(strTruncateStrict('abc', 3), 'abc')
            assert.equal(strTruncateStrict('abc', 0), '...')
            assert.equal(strTruncateStrict(null, 3), '')
        })

        it('[unit-oneline:11] 嚴格版下 src 原檔不拋錯:輸入字串空間 × 全部 n(有效／無效／改前寬鬆),輸出與一般載入逐字相同', async () => {
            const strict = await loadWithStrictStrTruncate(SRC)
            assert.notEqual(strict.oneline, oneline, '確為另一份載入(換入替身之實例)')
            let compared = 0
            for (const [sk, s] of S_CASES) {
                for (const [label, n] of [...N_VALID, ...N_INVALID, ...N_LEGACY_LENIENT]) {
                    let r
                    assert.doesNotThrow(() => {
                        r = call(strict.oneline, s, n)
                    }, `s=${sk} n=${label}`)
                    assert.equal(r, call(oneline, s, n), `s=${sk} n=${label}`)
                    compared++
                }
            }
            assert.equal(compared, S_CASES.length * (N_VALID.length + N_INVALID.length + N_LEGACY_LENIENT.length))
        })

        it('[unit-oneline:12] 無效 n 不轉給 strTruncate;有效 n 轉為數字(型別 number、count 範圍內)後才轉給 strTruncate', async () => {
            const strict = await loadWithStrictStrTruncate(SRC)
            for (const [label, n] of [...N_INVALID, ...N_LEGACY_LENIENT]) {
                calls.length = 0
                call(strict.oneline, LONG, n)
                assert.equal(calls.length, 0, `n=${label} 不應抵達 strTruncate`)
            }
            for (const [label, n, k] of N_VALID) {
                calls.length = 0
                call(strict.oneline, LONG, n)
                assert.equal(calls.length, 1, `n=${label}`)
                assert.equal(typeof calls[0].maxLen, 'number', `n=${label} 轉給 strTruncate 之值為數字(字串 '${String(n)}' 不原樣轉傳)`)
                assert.ok(calls[0].maxLen === k, `n=${label} 轉給 strTruncate 之值應為 ${k}(-0 與 0 視為同值)`)
                assert.equal(calls[0].str, LONG_LINE, `n=${label} 轉給 strTruncate 者為壓平後之整行`)
            }
        })
    })
})
