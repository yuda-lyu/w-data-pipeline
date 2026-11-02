// legacyOneline.mjs — 改前 oneline 之逐字複本與其依賴之 wsemi strTruncate「第 2 輪(寬鬆版)」,供前後差分之基準(測試輔助,不帶 .test.)
//
// 改前 oneline:  strTruncate(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
// 第 2 輪 strTruncate(wsemi 1.9.44 現行):str 非有效字串回 ''、maxLen 非有效非負整數(isp0int)則原樣回傳、未超長原樣、超長補 '...'。
// 自帶一份而不 import wsemi 的 strTruncate:wsemi 第 3 輪後該函數對無效 maxLen 改為拋錯,基準若隨之改變即失去「改前」的意義。

import isestr from 'wsemi/src/isestr.mjs'
import isp0int from 'wsemi/src/isp0int.mjs'
import cint from 'wsemi/src/cint.mjs'
import strleft from 'wsemi/src/strleft.mjs'

function strTruncateLenient(str, maxLen) {
    if (!isestr(str)) {
        return ''
    }
    if (!isp0int(maxLen)) {
        return str
    }
    maxLen = cint(maxLen)
    if (str.length <= maxLen) {
        return str
    }
    return strleft(str, maxLen) + '...'
}

export function legacyOneline(s, n = 200) {
    return strTruncateLenient(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
}

export default legacyOneline
