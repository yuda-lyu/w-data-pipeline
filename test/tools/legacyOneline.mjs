// legacyOneline.mjs — 改前 oneline 之自足複本,供前後差分之基準(測試輔助,不帶 .test.;不 import 任何 wsemi 函數)
//
// 改前 oneline:  strTruncate(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
// 其所依賴之 wsemi strTruncate「第 2 輪(寬鬆版)」之語意固定於此(凍結),不隨 wsemi 升版而變:
//   str 非有效字串(非字串或空字串)回 ''、maxLen 非「有效非負整數」則原樣回傳、未超長原樣、超長取前 maxLen 字補 '...'。
// 「有效非負整數」即改前 wsemi isp0int 之判定(wsemi 1.9.68 以前之 isnum／isint／cint 語意),內嵌於 legacyMaxLen:
//   ① 字串(含 String 包裝物件):去頭尾空白後非空,且 Number() 非 NaN(故 '0x10'、'0b11'、'1.5e1'、' 5 ' 皆視為數);
//   ② 數字(含 Number 包裝物件):非 NaN;
//   ③ 轉成數字後 ±Infinity 夾為 ±Number.MAX_VALUE(lodash toFinite),須為整數且 ≥ 0。
// 自足之理由:wsemi 1.9.69(W-20)起判斷函數只收原始值,isint(new Number(5)) 為 false;
//   基準若仍呼叫現行 wsemi 之 isp0int／cint／isestr／strleft,「改前」之輸出便隨 wsemi 版本改變而失去意義。

const tagOf = (v) => Object.prototype.toString.call(v)

/**
 * 改前判定:maxLen 為有效非負整數則回其值(±Infinity 夾為 ±Number.MAX_VALUE),否則回 null
 * @param {*} maxLen
 * @returns {number|null}
 */
function legacyMaxLen(maxLen) {
    let x
    if (tagOf(maxLen) === '[object String]') {
        const t = String(maxLen)
        if (t.trim() === '') {
            return null
        }
        x = Number(t)
    }
    else if (tagOf(maxLen) === '[object Number]') {
        x = Number(maxLen)
    }
    else {
        return null
    }
    if (Number.isNaN(x)) {
        return null
    }
    if (x === Infinity) {
        x = Number.MAX_VALUE
    }
    else if (x === -Infinity) {
        x = -Number.MAX_VALUE
    }
    if (!Number.isInteger(x) || !(x >= 0)) {
        return null
    }
    return x
}

function strTruncateLenient(str, maxLen) {
    if (typeof str !== 'string' || str === '') {
        return ''
    }
    const k = legacyMaxLen(maxLen)
    if (k === null) {
        return str
    }
    if (str.length <= k) {
        return str
    }
    return str.slice(0, k) + '...'
}

export function legacyOneline(s, n = 200) {
    return strTruncateLenient(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
}

export default legacyOneline
