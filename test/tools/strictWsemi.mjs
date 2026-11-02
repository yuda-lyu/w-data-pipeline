// strictWsemi.mjs — wsemi strTruncate「第 3 輪嚴格版」替身,與把它換進被測模組之載入器(測試輔助,不帶 .test.)
//
// 契約(wsemi 第 3 輪,主控 2026-11-02 派工說明;wsemi 本身尚未改,此處自寫以前瞻驗證下游不依賴寬鬆處置):
//   strTruncate(str, maxLen, opt):maxLen 為必須參數,以 iseint 之 count(0～4294967295 之安全整數)判定,未給或非預期即拋錯
//   (訊息 `invalid maxLen: must be a non-negative integer`,不帶值;dspec〈輸入參數之檢測機制〉§11 第 221 項待決 5);
//   其餘(str 非有效字串回 ''、未超長原樣、超長補 '...'、opt.funWithMsg)同第 2 輪。
// 換入方式:module.register 掛 resolve 鉤子,只在「父模組 URL 帶 ?strictWsemi=」時,把 'wsemi/src/strTruncate.mjs' 導向本檔,
//   故被測的是 src 原檔本身(非複本),且不影響同行程中以一般 URL 載入之模組。

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import iseint from 'wsemi/src/iseint.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import strleft from 'wsemi/src/strleft.mjs'

/** 替身被呼叫之紀錄(str、maxLen 原樣),供測試檢查「實際轉給 wsemi 之值」 */
export const calls = []

export default function strTruncateStrict(str, maxLen, opt = {}) {
    calls.push({ str, maxLen })
    if (!iseint(maxLen, { use: 'count' })) {
        throw new Error('invalid maxLen: must be a non-negative integer')
    }
    const n = Number(maxLen)
    if (!isestr(str)) {
        return ''
    }
    if (str.length <= n) {
        return str
    }
    let se = ''
    if (isfun(opt?.funWithMsg)) {
        const t = opt.funWithMsg(str, n)
        if (isestr(t)) {
            se = t
        }
    }
    return strleft(str, n) + `...${se}`
}

let registered = false
let seq = 0

/**
 * 載入 srcPath 指定之模組,並把其中 import 之 'wsemi/src/strTruncate.mjs' 換成嚴格版替身
 * @param {string} srcPath 被測模組之檔案路徑
 * @returns {Promise<object>} 模組命名空間
 */
export async function loadWithStrictStrTruncate(srcPath) {
    if (!registered) {
        register('./strictWsemiHooks.mjs', import.meta.url, { data: { stubUrl: import.meta.url } })
        registered = true
    }
    seq++
    return import(`${pathToFileURL(srcPath).href}?strictWsemi=${seq}`)
}
