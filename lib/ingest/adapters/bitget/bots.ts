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
  ParsedProfile,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { ProfileQualityReject } from '../../core/profile-quality'
import type { FetchSession, ReplayRequestTemplate } from '../../fetch/types'
import {
  capturePartitionedNumericLeaderboard,
  pageFetcher,
  replayJson,
  replayPaged,
  type LeaderboardPublicRequestProjectionInput,
} from '../../fetch/capture'
import { LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT } from '../../acquisition-manifest'
import {
  assertCanonicalBitgetBotsSource,
  assertBitgetBotsLeaderboardPublication,
  inspectBitgetBotsBoardPage,
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

const REVIEWED_PROFILE_TIMEFRAMES = new Set<number>([7, 30, 90])
const REQUESTABLE_PROFILE_TIMEFRAMES = new Set<number>([0, 7, 30, 90])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The parser deliberately keeps the top-level cumulative values as
 * timeframe=0 and ignores unknown performanceType values. Validate the RAW
 * envelope as well as the parsed projection so a missing/duplicated/malformed
 * requested window cannot be hidden by that tolerant parsing behaviour.
 *
 * Both Tier-B and Tier-C call this only after their immutable RAW write.
 */
function validateBitgetBotsProfile(
  profile: ParsedProfile,
  ctx: ParseCtx,
  requestedTimeframe: Timeframe,
  raw: unknown
): ProfileQualityReject[] {
  const blockingReasons: string[] = []
  const rawCounts = new Map<number, number>()
  const parsedCounts = new Map<number, number>()

  if (!REQUESTABLE_PROFILE_TIMEFRAMES.has(requestedTimeframe)) {
    blockingReasons.push('profile_requested_timeframe_unreviewed')
  }

  const wrapper = isRecord(raw) ? raw : null
  if (!wrapper) {
    blockingReasons.push('profile_payload_invalid')
  } else if (wrapper.timeframe !== requestedTimeframe) {
    blockingReasons.push('profile_requested_timeframe_mismatch')
  }

  const response = wrapper && isRecord(wrapper.strategyInfo) ? wrapper.strategyInfo : null
  if (!response || response.code !== '200') {
    blockingReasons.push('profile_response_invalid')
  }

  const info = response && isRecord(response.data) ? response.data : null
  if (!info) blockingReasons.push('profile_data_invalid')

  const performances = info?.performances
  if (!Array.isArray(performances)) {
    blockingReasons.push('profile_performances_invalid')
  } else {
    for (const performance of performances) {
      if (!isRecord(performance)) {
        blockingReasons.push('profile_performance_malformed')
        continue
      }
      const performanceType = performance.performanceType
      if (typeof performanceType !== 'number' || !Number.isInteger(performanceType)) {
        blockingReasons.push('profile_performance_type_malformed')
        continue
      }
      if (!REVIEWED_PROFILE_TIMEFRAMES.has(performanceType)) {
        blockingReasons.push('profile_performance_type_unreviewed')
        continue
      }
      rawCounts.set(performanceType, (rawCounts.get(performanceType) ?? 0) + 1)
    }
  }

  for (const count of rawCounts.values()) {
    if (count > 1) blockingReasons.push('profile_performance_type_duplicate')
  }

  for (const stat of profile.stats) {
    if (!REQUESTABLE_PROFILE_TIMEFRAMES.has(stat.timeframe)) {
      blockingReasons.push('profile_parsed_timeframe_unreviewed')
      continue
    }
    parsedCounts.set(stat.timeframe, (parsedCounts.get(stat.timeframe) ?? 0) + 1)
  }
  for (const count of parsedCounts.values()) {
    if (count > 1) blockingReasons.push('profile_parsed_timeframe_duplicate')
  }

  // timeframe=0 comes from the separately reviewed top-level cumulative
  // fields; ranking windows must each be backed by exactly one performances[]
  // row. In both cases the parsed result must contain exactly one requested
  // block before it is publishable or renderable.
  if (
    (requestedTimeframe !== 0 && rawCounts.get(requestedTimeframe) !== 1) ||
    parsedCounts.get(requestedTimeframe) !== 1
  ) {
    blockingReasons.push('profile_requested_timeframe_count_invalid')
  }

  // Prove every reviewed RAW window survived parsing exactly once. This
  // catches future parser drift without requiring unrelated windows to be
  // present in a response for the requested one.
  for (const timeframe of REVIEWED_PROFILE_TIMEFRAMES) {
    if ((rawCounts.get(timeframe) ?? 0) !== (parsedCounts.get(timeframe) ?? 0)) {
      blockingReasons.push('profile_window_projection_mismatch')
    }
  }

  const uniqueReasons = [...new Set(blockingReasons)]
  if (uniqueReasons.length === 0) return []

  return [
    {
      reason: uniqueReasons[0],
      payload: {
        requested_timeframe: requestedTimeframe,
        payload_timeframe: wrapper?.timeframe ?? null,
        source_slug: ctx.sourceSlug,
        blocking_reasons: uniqueReasons,
        raw_performance_counts: Object.fromEntries(rawCounts),
        parsed_stats_counts: Object.fromEntries(parsedCounts),
      },
    },
  ]
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

function configuredCallerPageCap(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 1
  ) {
    throw new TypeError('[bitget_bots] meta.max_pages must be a positive safe integer')
  }
  return value
}

const BITGET_BOT_LIST_BODY_FIELDS = ['strategyType', 'orderType', 'pageNo', 'pageSize'] as const

export function projectBitgetBotsLeaderboardRequest(
  actualRequest: ReplayRequestTemplate,
  expected: Readonly<{
    url: string
    strategyType: number
    pageIndex: number
    pageSize: number
  }>
): LeaderboardPublicRequestProjectionInput {
  let actualUrl: URL
  let expectedUrl: URL
  try {
    actualUrl = new URL(actualRequest.url)
    expectedUrl = new URL(expected.url)
  } catch {
    throw new TypeError('[bitget_bots] leaderboard request URL must be absolute')
  }
  if (
    actualRequest.method !== 'POST' ||
    actualUrl.href !== expectedUrl.href ||
    actualUrl.search !== '' ||
    actualUrl.hash !== '' ||
    actualUrl.username !== '' ||
    actualUrl.password !== ''
  ) {
    throw new TypeError('[bitget_bots] leaderboard request method or URL drifted')
  }
  if (!isRecord(actualRequest.body)) {
    throw new TypeError('[bitget_bots] leaderboard request body must be an exact JSON object')
  }
  const bodyKeys = Object.keys(actualRequest.body)
  if (
    bodyKeys.length !== BITGET_BOT_LIST_BODY_FIELDS.length ||
    bodyKeys.some(
      (field) =>
        !BITGET_BOT_LIST_BODY_FIELDS.includes(field as (typeof BITGET_BOT_LIST_BODY_FIELDS)[number])
    )
  ) {
    throw new TypeError('[bitget_bots] leaderboard request body fields drifted')
  }
  const body = actualRequest.body
  if (
    body.strategyType !== expected.strategyType ||
    body.orderType !== 3 ||
    body.pageNo !== expected.pageIndex ||
    body.pageSize !== expected.pageSize ||
    !Number.isSafeInteger(body.strategyType) ||
    !Number.isSafeInteger(body.pageNo) ||
    !Number.isSafeInteger(body.pageSize) ||
    body.pageNo < 1 ||
    body.pageSize < 1 ||
    Object.is(body.pageNo, -0) ||
    Object.is(body.pageSize, -0)
  ) {
    throw new TypeError('[bitget_bots] leaderboard request body values drifted')
  }
  return {
    url: actualUrl.href,
    method: 'POST',
    body: {
      strategyType: body.strategyType,
      orderType: body.orderType,
      pageNo: body.pageNo,
      pageSize: body.pageSize,
    },
  }
}

export async function captureBitgetBotsLeaderboard(
  session: FetchSession,
  src: SourceRow,
  timeframe: RankingTimeframe
) {
  const contract = assertCanonicalBitgetBotsSource(src, timeframe)
  const listUrl = endpoint(src, 'list', `${S_BASE}/traceRanks`)
  const pageSize = src.page_size!
  const callerPageCap = configuredCallerPageCap(src.meta.max_pages)
  await warmSession(session, src)

  return capturePartitionedNumericLeaderboard({
    session,
    fetcher: pageFetcher(session),
    partitions: contract.boards.map((board) => {
      const strategyType = BOT_BOARD_STRATEGY_TYPE[board]
      if (strategyType === undefined) {
        throw new TypeError(`[bitget_bots] unreviewed canonical board ${board}`)
      }
      let reportedTotal: number | null = null
      return {
        partitionId: board,
        buildRequest: (pageIndex: number) => ({
          url: listUrl,
          method: 'POST' as const,
          headers: HEADERS,
          body: { strategyType, orderType: 3, pageNo: pageIndex, pageSize },
        }),
        projectPublicRequest: (actualRequest: ReplayRequestTemplate, pageIndex: number) =>
          projectBitgetBotsLeaderboardRequest(actualRequest, {
            url: listUrl,
            strategyType,
            pageIndex,
            pageSize,
          }),
        pageBinding: { location: 'body' as const, path: ['pageNo'] },
        extractMeta: (payload: unknown, requestPageIndex: number) => {
          const decoded = inspectBitgetBotsBoardPage({
            data_contract: LEADERBOARD_PARTITIONED_NUMERIC_PARSER_PAGE_CONTRACT,
            partition_id: board,
            request_page_index: requestPageIndex,
            request_page_size: pageSize,
            payload,
          })
          if (reportedTotal === null) reportedTotal = decoded.page.reportedTotal
          else if (decoded.page.reportedTotal !== reportedTotal) {
            throw new TypeError(`[bitget_bots] ${board} totalRecord changed within one crawl`)
          }
          return {
            rowCount: decoded.page.rows.length,
            reportedPopulation: decoded.page.reportedTotal,
            reportedPageCount: null,
            reportedCurrentPage: decoded.reportedCurrentPage,
            reportedPageSize: null,
          }
        },
        pageSize,
        callerPageCap,
      }
    }),
  })
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
      let reportedTotalForBoard: number | null = null
      const inner = replayPaged({
        session,
        fetcher,
        buildRequest: (pageIndex) => ({
          url: listUrl,
          method: 'POST',
          headers: HEADERS,
          body: { strategyType, orderType: 3, pageNo: pageIndex, pageSize },
        }),
        extractMeta: (payload, requestPageIndex) => {
          const page = parseBitgetBotsBoardPage(
            { board, requestPageIndex, requestPageSize: pageSize, payload },
            dummyCtx(src)
          )
          if (reportedTotalForBoard === null) reportedTotalForBoard = page.reportedTotal
          else if (page.reportedTotal !== reportedTotalForBoard) {
            throw new TypeError(`[bitget_bots] ${board} totalRecord changed within one crawl`)
          }
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
          payload: {
            board,
            requestPageIndex: page.pageIndex,
            requestPageSize: pageSize,
            payload: page.payload,
          },
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
  validateLeaderboard: assertBitgetBotsLeaderboardPublication,
  parseProfile: parseBitgetBotsProfile,
  validateProfile: validateBitgetBotsProfile,

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
