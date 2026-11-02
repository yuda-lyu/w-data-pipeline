// strictWsemiHooks.mjs — strictWsemi.mjs 以 module.register 掛上之 resolve 鉤子(於載入器執行緒執行)
// 只改寫「父模組 URL 帶 ?strictWsemi=」者對 'wsemi/src/strTruncate.mjs' 之解析,其餘一律交回預設解析。

let stubUrl = ''

export function initialize(data) {
    stubUrl = data.stubUrl
}

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'wsemi/src/strTruncate.mjs' && String(context.parentURL).includes('?strictWsemi=')) {
        return { url: stubUrl, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
}
