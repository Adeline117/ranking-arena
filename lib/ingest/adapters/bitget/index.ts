/**
 * Bitget adapter (Phase 0 reference source — spec §15 Phase 0, §11.4).
 * One adapter serves bitget_futures / bitget_spot / bitget_cfd; the board
 * is selected by src.meta.boardKey. Known JSON endpoints (from the legacy
 * connector, overridable per-source via src.meta.endpoints):
 *   list (UTA): POST /v1/trigger/public/uta/traderView (futures; spot/cfd below)
 *   profile:    POST /v1/trigger/trace/public/traderDetailPageV2 {traderUid}
 *   charts:     POST /v1/trigger/trace/public/cycleData {triggerUserId, cycleTime}
 *   CFD profile: POST /v1/trace/mt5/public/{details,performance}
 *               {portfolioId[, cycleTime]} (./profile-capture-contract.ts)
 * (legacy trader/detail + profitList endpoints are dead — verified 2026-06-11)
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson, UpstreamGoneError } from '../../fetch/capture'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
import {
  parseBitgetHistory,
  parseBitgetLeaderboardPage,
  parseBitgetPositions,
  parseBitgetProfile,
} from './parsers'
import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
  type HistoryTerminalClaimReason,
} from '../../history-acquisition'
import {
  BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BITGET_POSITION_HISTORY_URL,
  bitgetPositionHistoryTerminalVerifier,
} from './history-terminal'
import { BITGET_CFD_PROFILE_URLS } from './profile-capture-contract'

const BASE = 'https://www.bitget.com/v1/trigger/trace/public'
const TRACE_BASE = 'https://www.bitget.com/v1/trigger/trace'
/** UTA portfolio-trader profile family (board rows with type=2; keyed by
 *  portfolioId from traders.meta — traderUid is rejected). Profile page:
 *  /zh-CN/copy-trading/futures-trader/{portfolioId} (verified 2026-06-11). */
const UTA_BASE = 'https://www.bitget.com/v1/trigger/public/uta'

/** UTA board-list endpoints per boardKey (verified by live capture 2026-06). */
const UTA_LIST_ENDPOINTS: Record<string, string> = {
  futures: 'https://www.bitget.com/v1/trigger/public/uta/traderView',
  spot: 'https://www.bitget.com/v1/trace/spot/public/uta/traderView',
  cfd: 'https://www.bitget.com/v1/trace/mt5/public/traderView',
}

const UTA_HEADERS = {
  'content-type': 'application/json;charset=UTF-8',
  language: 'zh_CN',
  locale: 'zh_CN',
  website: 'copy',
  terminaltype: '1',
}

/**
 * UTA board page meta (public probe 2026-11-15, all three boards × 7/30/90):
 * success envelope is the string code "200"; `data.rows` is the board page;
 * `data.totals` is only this page's row count; `data.maxShowSizes` is the
 * board population. Spot and CFD boards page out to exactly maxShowSizes
 * distinct traders (cfd 30D 208 = 6×30+28, cfd 7D 204, spot 30D/7D 5416 =
 * 180×30+16) and then serve an empty page. The futures board reports 9473 for
 * every window while its flagged tail ends between pages 314 and 316 with
 * replica-dependent rows, so its captures stop short of the reported total
 * and stay non-complete (fail closed) rather than being certified by nextFlag.
 */
const bitgetLeaderboardMeta = collectionMeta({
  label: 'bitget',
  assertSuccess: requireEnvelopeValue('bitget', ['code'], ['200']),
  list: ['data', 'rows'],
  total: ['data', 'maxShowSizes'],
})

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function historyTerminalClaim(
  reason: HistoryTerminalClaimReason,
  pageOrdinal: number
): HistoryTerminalClaim {
  return {
    contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
    observations: [{ segment_id: 'default', reason, page_ordinal: pageOrdinal }],
  }
}

/**
 * Bitget's WAF 403s cold API hits; one page load establishes the session
 * cookies and the rest is pure JSON replay (spec §2.2). Warm once per
 * FetchSession — the persistent context keeps cookies across runs, so
 * subsequent sessions usually replay without a fresh page load.
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.bitget.com/zh-CN/copy-trading/futures'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  try {
    await page.waitForLoadState('networkidle', { timeout: 20_000 })
  } catch {
    // networkidle is best-effort — a busy page still yields valid cookies
  }
  warmedSessions.add(session)
}

/** Session-scoped detailV2 cache (LRU-ish: cleared per trader change is
 *  unnecessary — Tier-B visits each trader once, 3 TFs back to back). */
const detailV2Cache = new WeakMap<FetchSession, Map<string, unknown>>()

async function cachedDetailV2(
  session: FetchSession,
  traderId: string,
  fetch: () => Promise<unknown>
): Promise<unknown> {
  let cache = detailV2Cache.get(session)
  if (!cache) {
    cache = new Map()
    detailV2Cache.set(session, cache)
  }
  if (cache.has(traderId)) return cache.get(traderId)
  const value = await fetch()
  // Bound memory on long sessions: keep only the most recent traders.
  if (cache.size > 50) cache.clear()
  cache.set(traderId, value)
  return value
}

/** Business code of a portfolio endpoint answering an unknown or closed portfolio. */
const PORTFOLIO_CLOSED_CODE = 'portfolio_already_closed'

/**
 * `data` of a portfolio-endpoint envelope. These endpoints answer HTTP 200
 * for every outcome, so a business failure must fail the fetch here instead
 * of parsing as an empty profile.
 */
function portfolioEnvelopeData(
  label: string,
  url: string,
  envelope: unknown
): Record<string, unknown> {
  const code = isRecord(envelope) ? envelope.code : undefined
  if (code === PORTFOLIO_CLOSED_CODE) throw new UpstreamGoneError(410, url)
  if (code !== '200' || !isRecord(envelope) || !isRecord(envelope.data)) {
    throw new Error(`[bitget] ${label} returned a non-success API envelope (code=${String(code)})`)
  }
  return envelope.data
}

/**
 * CFD portfolio profile (public probe 2026-11-20). The trace family answers
 * CFD traders 30081, so the CFD board has its own endpoints keyed by the
 * board row's portfolioId (traders.meta.portfolio_id):
 *   details {portfolioId}                  identity + 跟单者 block; its
 *       traderAccountId is the board row's traderUid. An unknown or closed
 *       portfolio answers code portfolio_already_closed (performance still
 *       answers 200 with zeros and no maxDrawDown, so details is the gate).
 *   performance {portfolioId, cycleTime}   the window's 表现 block
 * One request returns one window: a trader's three windows cost one details
 * request (memoized per session) plus three performance requests.
 * cycleChartData {portfolioId, cycleTime} is not fetched: its roiRows/pnlRows
 * are the since-inception cumulative curve cut to the window (last point =
 * lifetime value, window value = last - first), not a window series.
 */
async function getCfdProfile(
  session: FetchSession,
  fetcher: ReturnType<typeof pageFetcher>,
  exchangeTraderId: string,
  tf: RankingTimeframe,
  traderMeta: Record<string, unknown> | null | undefined
): Promise<RawBundle> {
  const portfolioId = traderMeta?.portfolio_id ? String(traderMeta.portfolio_id) : null
  if (portfolioId === null) {
    throw new Error(`[bitget] CFD trader ${exchangeTraderId} has no portfolio_id in traders.meta`)
  }
  const post = (url: string, body: Record<string, unknown>) =>
    replayJson(session, fetcher, { url, method: 'POST', headers: UTA_HEADERS, body })

  const cfdDetails = await cachedDetailV2(
    session,
    `cfd:${portfolioId}:${exchangeTraderId}`,
    async () => {
      const envelope = await post(BITGET_CFD_PROFILE_URLS.details, { portfolioId })
      const data = portfolioEnvelopeData('CFD details', BITGET_CFD_PROFILE_URLS.details, envelope)
      // The evidence attempt is the trader's; the request is keyed by the
      // portfolio. Refuse a portfolio that belongs to another trader.
      if (data.traderAccountId !== exchangeTraderId) {
        throw new Error(
          `[bitget] CFD portfolio ${portfolioId} belongs to ${String(data.traderAccountId)}, ` +
            `not ${exchangeTraderId}`
        )
      }
      return envelope
    }
  )
  const cfdPerformance = await post(BITGET_CFD_PROFILE_URLS.performance, {
    portfolioId,
    cycleTime: tf,
  })
  portfolioEnvelopeData('CFD performance', BITGET_CFD_PROFILE_URLS.performance, cfdPerformance)

  // The page url is the performance request with the POST body's identity as
  // the query, so the profile capture manifest binds the portfolio and the
  // window it was fetched for (./profile-capture-contract.ts).
  const performanceUrl = new URL(BITGET_CFD_PROFILE_URLS.performance)
  performanceUrl.searchParams.set('portfolioId', portfolioId)
  performanceUrl.searchParams.set('cycleTime', String(tf))
  const fetchedAt = new Date().toISOString()
  return {
    pages: [
      {
        pageIndex: 1,
        payload: { cfdDetails, cfdPerformance, timeframe: tf },
        url: performanceUrl.toString(),
        fetchedAt,
      },
    ],
    fetchedAt,
  }
}

const bitgetAdapter: SourceAdapter = {
  slug: 'bitget',
  capabilities: {
    profile: true,
    positions: true, // POST public/traderPosition (1h-delayed for non-copiers)
    positionHistory: true, // POST trace/order/historyList (历史带单)
    orders: false,
    // 余额历史 no longer exists in the UTA profile UI (2026-06-11): all
    // balance/transfer endpoint candidates demand an auth token (00005).
    transfers: false,
    copiers: true, // POST trace/trader/followerList (top-50 only, PII rules apply)
  },

  historyTerminalVerifier(src, kind) {
    return src.slug === 'bitget_futures' &&
      src.product_type === 'futures' &&
      kind === 'position_history' &&
      endpoint(src, 'positionHistory', BITGET_POSITION_HISTORY_URL) === BITGET_POSITION_HISTORY_URL
      ? bitgetPositionHistoryTerminalVerifier
      : null
  },

  async captureLeaderboard(session, src, timeframe, options) {
    options?.signal?.throwIfAborted()
    await warmSession(session, src)
    options?.signal?.throwIfAborted()
    // The UTA API 403s external requests (signed tm/dy-token headers) but
    // accepts same-origin in-page fetches without them — so replay runs
    // through pageFetcher. Rapid unsigned requests get silently served
    // EMPTY rows, which the paced gate's 2.5s budget avoids; an empty page
    // before the reported population ends the capture non-complete.
    const fetcher = pageFetcher(session)
    const boardKey = (src.meta.boardKey as string) ?? 'futures'
    const listUrl = endpoint(src, 'list', UTA_LIST_ENDPOINTS[boardKey])
    const pageSize = src.page_size ?? 30
    return captureReplayLeaderboard(
      { session, fetcher, src, label: 'bitget', signal: options?.signal },
      {
        buildRequest: (pageIndex) => ({
          url: listUrl,
          method: 'POST',
          headers: UTA_HEADERS,
          body: {
            pageNo: pageIndex,
            pageSize,
            sortRule: 2,
            sortFlag: 0,
            dataCycle: timeframe,
            fullStatus: 1,
            languageType: 1,
          },
        }),
        publicRequest: {
          body: [
            'pageNo',
            'pageSize',
            'sortRule',
            'sortFlag',
            'dataCycle',
            'fullStatus',
            'languageType',
          ],
        },
        pageBinding: { location: 'body', path: ['pageNo'] },
        extractMeta: bitgetLeaderboardMeta,
        pageSize,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await bitgetAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe,
    traderMeta?: Record<string, unknown> | null
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe

    if (src.meta.boardKey === 'cfd') {
      return getCfdProfile(session, fetcher, exchangeTraderId, tf, traderMeta)
    }

    // UTA portfolio traders (type=2): different endpoint family keyed by
    // portfolioId — the trace family rejects their traderUid with 30081.
    const portfolioId =
      Number(traderMeta?.bitget_trader_type) === 2 && traderMeta?.portfolio_id
        ? String(traderMeta.portfolio_id)
        : null
    if (portfolioId !== null) {
      const utaDetails = await cachedDetailV2(session, `uta:${portfolioId}`, () =>
        replayJson(session, fetcher, {
          url: endpoint(src, 'utaDetails', `${UTA_BASE}/details`),
          method: 'POST',
          headers: UTA_HEADERS,
          body: { portfolioId },
        })
      )
      const utaPerformance = await replayJson(session, fetcher, {
        url: endpoint(src, 'utaPerformance', `${UTA_BASE}/performance`),
        method: 'POST',
        headers: UTA_HEADERS,
        body: { portfolioId, cycleTime: tf },
      })
      const utaChart = await replayJson(session, fetcher, {
        url: endpoint(src, 'utaChart', `${UTA_BASE}/cycleChartData`),
        method: 'POST',
        headers: UTA_HEADERS,
        body: { portfolioId, cycleTime: tf },
      })
      const fetchedAt = new Date().toISOString()
      return {
        pages: [
          {
            pageIndex: 1,
            payload: { utaDetails, utaPerformance, utaChart, timeframe: tf },
            url: `${UTA_BASE}/performance`,
            fetchedAt,
          },
        ],
        fetchedAt,
      }
    }

    // Futures family only. Public probes 2026-11-17 / 2026-11-20: spot board
    // traders (type 1, with a portfolioId) get detailV2 code 30081 ("not a
    // futures expert") and a cycleData success envelope whose statisticsDTO is
    // null. The spot trader page reads /v1/trace/spot/public/uta/{details,
    // performance,cycleChartData} instead, but neither that page nor its
    // performance response carries a drawdown for any window, and the board
    // row has none either: bitget_spot has no exchange-provided drawdown, so it
    // has no profile capture contract (./profile-capture-contract.ts).
    const detailUrl = endpoint(src, 'profile', `${BASE}/traderDetailPageV2`)
    const cycleUrl = endpoint(src, 'cycleData', `${BASE}/cycleData`)

    // detailV2 is timeframe-independent — fetch once per (session, trader)
    // and reuse across the 3 TF calls Tier-B makes back to back.
    const detailV2 = await cachedDetailV2(session, exchangeTraderId, () =>
      replayJson(session, fetcher, {
        url: detailUrl,
        method: 'POST',
        headers: UTA_HEADERS,
        body: { traderUid: exchangeTraderId },
      })
    )
    const cycleData = await replayJson(session, fetcher, {
      url: cycleUrl,
      method: 'POST',
      headers: UTA_HEADERS,
      body: { triggerUserId: exchangeTraderId, cycleTime: tf },
    })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detailV2, cycleData, timeframe: tf },
          url: cycleUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url = endpoint(src, 'positions', `${BASE}/traderPosition`)
    const payload = await replayJson(session, fetcher, {
      url,
      method: 'POST',
      headers: UTA_HEADERS,
      body: { traderUid: exchangeTraderId },
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Incremental history pages, newest→oldest (spec §2.3).
   *   position_history: POST trace/order/historyList (sorted by closeTime
   *     desc) — stops on cursor overlap (oldest closeTime ≤ stored cursor).
   *   copiers: POST trace/trader/followerList — small (top-50), always full.
   * NOT replayPaged: its completeness assertion treats an early cursor stop
   * as a truncated crawl; incremental stops are the point here.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncGenerator<RawPage, HistoryTerminalClaim, void> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[bitget] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url =
      kind === 'position_history'
        ? endpoint(src, 'positionHistory', BITGET_POSITION_HISTORY_URL)
        : endpoint(src, 'copiers', `${TRACE_BASE}/trader/followerList`)
    const pageSize = kind === 'copiers' ? 10 : 20
    // First-sight backfill depth cap (configurable per source); incremental
    // runs stop on cursor overlap long before hitting it.
    const maxPages = Number(src.meta.history_max_pages ?? 25) || 25
    const cursorMs = cursor ? Date.parse(cursor) : NaN

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const request = { pageNo, pageSize, traderUid: exchangeTraderId }
      const payload = await replayJson(session, fetcher, {
        url,
        method: 'POST',
        headers: UTA_HEADERS,
        body: request,
      })
      yield {
        pageIndex: pageNo,
        payload: {
          contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
          historyTraderIdentity: exchangeTraderId,
          request,
          response: payload,
        },
        url,
        fetchedAt: new Date().toISOString(),
      }

      if (!isRecord(payload) || payload.code !== '00000') {
        throw new Error(`[bitget] ${kind} returned a non-success API envelope`)
      }
      if (!isRecord(payload.data)) {
        throw new Error(`[bitget] ${kind} returned a malformed rows envelope`)
      }
      const data = payload.data
      const rawRows = data.rows
      if (!Array.isArray(rawRows)) {
        throw new Error(`[bitget] ${kind} returned a malformed rows envelope`)
      }
      if (!rawRows.every(isRecord) || rawRows.length > pageSize) {
        throw new Error(`[bitget] ${kind} returned an invalid history page`)
      }
      const rows = rawRows.filter(isRecord)
      if (
        data.nextFlag !== undefined &&
        data.nextFlag !== null &&
        typeof data.nextFlag !== 'boolean'
      ) {
        throw new Error(`[bitget] ${kind} returned an invalid nextFlag`)
      }
      if (data.nextFlag === false) return historyTerminalClaim('reported_end', pageNo)
      if (rows.length < pageSize && data.nextFlag === true) {
        throw new Error(`[bitget] ${kind} short page still claims continuation`)
      }
      if (rows.length === 0) return historyTerminalClaim('empty_page', pageNo)
      if (rows.length < pageSize) return historyTerminalClaim('short_page', pageNo)
      if (kind === 'position_history' && Number.isFinite(cursorMs)) {
        const closeTimes = rows
          .map((row) => Number(row.closeTime))
          .filter((closeTime) => Number.isFinite(closeTime) && closeTime > 0)
        // Overlap reached: this page already dips into stored history.
        if (closeTimes.length > 0 && Math.min(...closeTimes) <= cursorMs) {
          return historyTerminalClaim('cursor_overlap', pageNo)
        }
      }
    }
    throw new Error(`[bitget] ${kind} reached page cap ${maxPages} without terminal proof`)
  },

  parseLeaderboard: parseBitgetLeaderboardPage,
  parseProfile: parseBitgetProfile,

  parsePositions: parseBitgetPositions,

  parseHistory: parseBitgetHistory,
}

registerAdapter(bitgetAdapter)

export { bitgetAdapter }
