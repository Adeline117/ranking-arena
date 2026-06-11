/**
 * Bitget Bots adapter (spec §11.5, §1.3) — 4 strategy boards at
 * /zh-CN/copy-trading/bot, all verified by live capture 2026-06-11:
 *
 *   board:   POST /v1/strategyPlatform/public/traceRanks
 *            {strategyType, orderType: 3, pageNo, pageSize: 20}
 *            strategyType: 1 spot grid · 2 futures grid ·
 *                          3 spot martingale · 4 futures martingale
 *            → data.data[] bot cards, data.totalRecord, nextFlag
 *   profile: POST /v1/strategyPlatform/public/tradeStrategyInfo {strategyId}
 *            → performances[] (performanceType 7/30/90) + cumulative
 *              (inception) top-level stats + 30d profit chart
 *   copiers: POST /v1/strategyPlatform/public/followRank {strategyId}
 *            → followers[] + lastUpdateTime (used as the true as_of, §5.7)
 *
 * Each card is a bot INSTANCE: strategyId = exchange_bot_id = the shadow
 * trader's exchange_trader_id (trader_kind='bot', spec §3 shadow-row).
 * The board is TF-less (ranked by cumulative ROI) — sources rows pin
 * timeframes_native=[30] so Tier-A crawls each board family exactly once.
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  ParseCtx,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson, replayPaged } from '../../fetch/capture'
import {
  parseBitgetBotsBoardPage,
  parseBitgetBotsCopiers,
  parseBitgetBotsProfile,
} from './bots-parsers'

const S_BASE = 'https://www.bitget.com/v1/strategyPlatform/public'

export const BOT_BOARD_STRATEGY_TYPE: Record<string, number> = {
  spot_grid: 1,
  futures_grid: 2,
  spot_martingale: 3,
  futures_martingale: 4,
}

const HEADERS = {
  'content-type': 'application/json;charset=UTF-8',
  language: 'zh_CN',
  locale: 'zh_CN',
  terminaltype: '1',
}

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** One warm page load per session establishes WAF cookies (as for the
 *  copy-trading boards); strategyPlatform replays are same-origin fetches. */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.bitget.com/zh-CN/copy-trading/bot'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

/** Session-scoped tradeStrategyInfo cache: one fetch serves all TF parses. */
const strategyInfoCache = new WeakMap<FetchSession, Map<string, unknown>>()

async function cachedStrategyInfo(
  session: FetchSession,
  strategyId: string,
  fetch: () => Promise<unknown>
): Promise<unknown> {
  let cache = strategyInfoCache.get(session)
  if (!cache) {
    cache = new Map()
    strategyInfoCache.set(session, cache)
  }
  if (cache.has(strategyId)) return cache.get(strategyId)
  const value = await fetch()
  if (cache.size > 50) cache.clear()
  cache.set(strategyId, value)
  return value
}

const bitgetBotsAdapter: SourceAdapter = {
  slug: 'bitget_bots',
  capabilities: {
    profile: true, // tradeStrategyInfo {strategyId}
    positions: false,
    positionHistory: false,
    orders: false,
    transfers: false,
    copiers: true, // followRank {strategyId} — ts from lastUpdateTime
  },

  /**
   * One source covers two boards (e.g. futures_grid + futures_martingale,
   * src.meta.boards). Pages from the second board continue the pageIndex
   * sequence so Tier-A's global rank re-anchor stays collision-free.
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    _timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list', `${S_BASE}/traceRanks`)
    const pageSize = src.page_size ?? 20
    const boards = (src.meta.boards as string[]) ?? []

    let pageOffset = 0
    for (const board of boards) {
      const strategyType = BOT_BOARD_STRATEGY_TYPE[board]
      if (strategyType === undefined) {
        throw new Error(`[bitget_bots] unknown board "${board}" in src.meta.boards`)
      }
      let pagesThisBoard = 0
      const inner = replayPaged({
        session,
        fetcher,
        buildRequest: (pageIndex) => ({
          url: listUrl,
          method: 'POST',
          headers: HEADERS,
          body: { strategyType, orderType: 3, pageNo: pageIndex, pageSize },
        }),
        extractMeta: (payload) => {
          const page = parseBitgetBotsBoardPage({ board, payload }, dummyCtx(src))
          return { rowCount: page.rows.length, reportedTotal: page.reportedTotal }
        },
        pageSize,
      })
      for await (const page of inner) {
        pagesThisBoard = Math.max(pagesThisBoard, page.pageIndex)
        // RAW stores the wrapped payload so the parser stays pure (raw, ctx).
        yield {
          ...page,
          pageIndex: page.pageIndex + pageOffset,
          payload: { board, payload: page.payload },
        }
      }
      pageOffset += pagesThisBoard
    }
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string, // = strategyId (shadow-row identity)
    timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url = endpoint(src, 'strategyInfo', `${S_BASE}/tradeStrategyInfo`)
    // One payload carries all TFs (performances[]) + inception + chart, so
    // the per-TF calls Tier-B makes resolve from the session cache.
    const strategyInfo = await cachedStrategyInfo(session, exchangeTraderId, () =>
      replayJson(session, fetcher, {
        url,
        method: 'POST',
        headers: HEADERS,
        body: { strategyId: exchangeTraderId },
      })
    )
    const fetchedAt = new Date().toISOString()
    return {
      pages: [{ pageIndex: 1, payload: { strategyInfo, timeframe }, url, fetchedAt }],
      fetchedAt,
    }
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[bitget_bots] positions surface not exposed by Bitget')
  },

  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    if (kind !== 'copiers') {
      throw new Error(`[bitget_bots] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url = endpoint(src, 'copiers', `${S_BASE}/followRank`)
    const payload = await replayJson(session, fetcher, {
      url,
      method: 'POST',
      headers: HEADERS,
      body: { strategyId: exchangeTraderId },
    })
    yield { pageIndex: 1, payload, url, fetchedAt: new Date().toISOString() }
  },

  parseLeaderboard: parseBitgetBotsBoardPage,
  parseProfile: parseBitgetBotsProfile,

  parsePositions(): never {
    throw new Error('[bitget_bots] positions parser not supported')
  },

  parseHistory(raw: unknown, kind: HistoryKind, ctx: ParseCtx) {
    if (kind !== 'copiers') {
      throw new Error(`[bitget_bots] history parser ${kind} not supported`)
    }
    return parseBitgetBotsCopiers(raw, ctx)
  },
}

/** Parse-time ctx for extractMeta inside the replay loop (counts only). */
function dummyCtx(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
}

registerAdapter(bitgetBotsAdapter)

export { bitgetBotsAdapter }
