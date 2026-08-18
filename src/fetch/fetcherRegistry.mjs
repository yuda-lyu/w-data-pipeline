import { ContractError } from '../core/errors.mjs'
import { defineFetcher } from './defineFetcher.mjs'

/**
 * 建立抓取器登錄簿。
 *
 * 【為何要一層登錄簿】外部注入的是一個扁平清單，但執行時要回答的是
 * 「這個目標該由誰抓」。把這個對應關係集中在一處，來源記錄裡就只需存 kind
 * （純資料，可寫進資料庫與設定檔），不必存函數。
 *
 * 【id 重複一律拋錯】重複時後者覆蓋前者是靜默失效的溫床：清單裡明明有兩個抓取器，
 * 實際只有一個會被用到，而日誌上完全看不出來，故定義期即擋。
 *
 * @param {Array} fetchers defineFetcher 之產出，或可被 defineFetcher 接受的 spec
 * @returns {object} 登錄簿：{ list, ids, get, byRole, resolve, label }
 */
export function createFetcherRegistry(fetchers) {
    if (!Array.isArray(fetchers) || fetchers.length === 0) {
        throw new ContractError('抓取器清單必須是非空陣列')
    }
    const list = fetchers.map((f) => (f && f.__kind === 'fetcher' ? f : defineFetcher(f)))

    const byId = new Map()
    for (const f of list) {
        if (byId.has(f.id)) throw new ContractError(`抓取器 id 重複：${f.id}`)
        byId.set(f.id, f)
    }

    /**
   * 解析某目標該由哪個抓取器處理。
   * @param {'list'|'detail'} role
   * @param {object} target list 角色時為 source，detail 角色時為 item
   * @param {object} [ctx]
   * @returns {object|null} 抓取器；無人可處理時回 null（由呼叫端決定報錯或略過）
   */
    const resolve = (role, target, ctx) => {
    // ① 目標指名：來源記錄可寫 fetcher:'browser' 這類 id 強制指定，覆蓋一切自動判定。
    //    指名了卻找不到／角色不符一律拋錯——指名是明確意圖，默默改用別的抓取器
    //    會讓「這個站要用瀏覽器抓」的設定悄悄失效。
        const named = String(target?.fetcher || '').trim()
        if (named) {
            const f = byId.get(named)
            if (!f) throw new ContractError(`目標指名了未註冊的抓取器：${named}（已註冊：${[...byId.keys()].join('、')}）`)
            if (f.role !== role) throw new ContractError(`抓取器[${named}] 的 role 是 ${f.role}，不能用於 ${role}`)
            return f
        }
        const candidates = list.filter((f) => f.role === role)
        // ② kind 對應（最常見路徑）
        const kind = String(target?.kind || '').trim()
        if (kind) {
            const f = candidates.find((x) => x.kinds.includes(kind))
            if (f) return f
        }
        // ③ 自訂判定（按註冊順序，先中先贏）
        for (const f of candidates) {
            if (f.match && f.match(target, ctx)) return f
        }
        return null
    }

    return {
        list,
        ids: [...byId.keys()],
        get: (id) => byId.get(id) || null,
        /** 某角色的抓取器（未註冊該角色時回空陣列） */
        byRole: (role) => list.filter((f) => f.role === role),
        resolve,
        /** 可讀摘要（供啟動日誌顯示已註冊哪些抓取器） */
        label: () => list.map((f) => `${f.id}(${f.role}${f.kinds.length ? `:${f.kinds.join(',')}` : ''})`).join(' / '),
    }
}

export default createFetcherRegistry
