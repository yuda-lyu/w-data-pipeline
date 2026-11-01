import { definePipeline, runPipeline } from './core/definePipeline.mjs'
import { defineStage } from './core/defineStage.mjs'
import { createContext } from './core/context.mjs'
import { ContractError, StageError, PipelineError, isTimeoutError } from './core/errors.mjs'
import { defineFetcher } from './fetch/defineFetcher.mjs'
import { createFetcherRegistry } from './fetch/fetcherRegistry.mjs'
import { runListFetch } from './fetch/runListFetch.mjs'
import { runDetailFetch } from './fetch/runDetailFetch.mjs'
import { normalizeItem, normalizeItems, normalizeContent } from './fetch/itemContract.mjs'
import { createSeenStore } from './dedup/createSeenStore.mjs'
import { createIdentity, defaultIdentityOf } from './dedup/identity.mjs'
import { openCollection, withCollections } from './dedup/openCollection.mjs'
import { keyStrategies, resolveKeyOf } from './dedup/keyOf.mjs'
import { normalizeUrl, unwrapRedirectUrl, isHttpUrl, DEFAULT_UNWRAP_RULES } from './util/normalizeUrl.mjs'
import { mapLimit } from './util/mapLimit.mjs'
import { oneline } from './util/oneline.mjs'
import { normalizeLogger, nullLogger } from './util/logger.mjs'
import { acquireLock, inspectLock } from './lock/executionLock.mjs'
import { deadlineMsOf, parseIsoDuration, DEADLINE_MARGIN_MS, DEADLINE_FLOOR_MS } from './budget/deadline.mjs'
import { budgetOf, reserveOf, reserveMsOf } from './budget/budget.mjs'
import { createRunLogger, createLogger } from './log/runLogger.mjs'


/**
 * 資料抓取與彙整管道工具
 *
 * 提供四項核心能力：
 * ① 管道（definePipeline／defineStage／runPipeline）：外部給階段清單，套件給秩序
 *    （逐段計時、失敗隔離、停止與收尾、執行鎖與時間預算），且管道可巢狀
 * ② 抓取器（defineFetcher／createFetcherRegistry／runListFetch／runDetailFetch）：
 *    「怎麼抓」由外部注入，套件只定義接什麼、回什麼、失敗怎麼算
 * ③ 去重檢測器（createSeenStore／createIdentity）：以主鍵判斷是否已抓過，
 *    判定與占位由 LMDB 原子完成
 * ④ 執行鎖、截止推導、預算介面與落檔日誌（acquireLock／inspectLock、deadlineMsOf／parseIsoDuration、
 *    budgetOf／reserveOf／reserveMsOf、createRunLogger／createLogger）：
 *    分別為 spec.lock、spec.deadlineMs、ctx 時間預算消費、spec.log 之可選預設實作，外部仍可注入自有實作
 *
 * @returns {Object} 回傳套件物件，含 definePipeline、runPipeline、defineStage、createContext、
 *     ContractError、StageError、PipelineError、isTimeoutError、defineFetcher、createFetcherRegistry、
 *     runListFetch、runDetailFetch、normalizeItem、normalizeItems、normalizeContent、createSeenStore、
 *     createIdentity、defaultIdentityOf、openCollection、withCollections、keyStrategies、resolveKeyOf、
 *     normalizeUrl、unwrapRedirectUrl、isHttpUrl、DEFAULT_UNWRAP_RULES、mapLimit、oneline、
 *     normalizeLogger、nullLogger、acquireLock、inspectLock、deadlineMsOf、parseIsoDuration、
 *     DEADLINE_MARGIN_MS、DEADLINE_FLOOR_MS、budgetOf、reserveOf、reserveMsOf、createRunLogger、
 *     createLogger 等函數
 * @example
 * import WDataPipeline from 'w-data-pipeline'
 * let { definePipeline, runPipeline, defineFetcher, createFetcherRegistry, createSeenStore } = WDataPipeline
 */
let WDataPipeline = {

    //管道
    definePipeline,
    runPipeline,
    defineStage,
    createContext,
    ContractError,
    StageError,
    PipelineError,
    isTimeoutError,

    //抓取器（依賴注入
    defineFetcher,
    createFetcherRegistry,
    runListFetch,
    runDetailFetch,
    normalizeItem,
    normalizeItems,
    normalizeContent,

    //去重檢測器
    createSeenStore,
    createIdentity,
    defaultIdentityOf,
    openCollection,
    withCollections,
    keyStrategies,
    resolveKeyOf,

    //工具
    normalizeUrl,
    unwrapRedirectUrl,
    isHttpUrl,
    DEFAULT_UNWRAP_RULES,
    mapLimit,
    oneline,
    normalizeLogger,
    nullLogger,

    //執行鎖（spec.lock 之可選預設實作）
    acquireLock,
    inspectLock,

    //截止推導（spec.deadlineMs）與預算介面（各段只經 budgetOf(ctx) 消費剩餘時間）
    deadlineMsOf,
    parseIsoDuration,
    DEADLINE_MARGIN_MS,
    DEADLINE_FLOOR_MS,
    budgetOf,
    reserveOf,
    reserveMsOf,

    //落檔日誌（spec.log 之可選預設實作）
    createRunLogger,
    createLogger,

}


export default WDataPipeline
