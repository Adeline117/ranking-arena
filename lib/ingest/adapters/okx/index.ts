/**
 * OKX CEX copy-trading adapter (spec §7 #9, §9 open item 2) — okx_futures
 * (instType=SWAP) + okx_spot (instType=SPOT), one adapter parameterized by
 * sources.meta.inst_type.
 *
 * PURE HTTP — no Playwright. The OFFICIAL documented public API answers
 * plain fetch() (verified live 2026-06-12 from the SG VPS and 2026-11-15
 * from the local Mac — the web UI geo-hides copy trading, but the data API
 * serves globally; migration 20261116204359 moves okx_futures/okx_spot from
 * fetch_region='vps_sg' to 'local', so the local worker fetches them):
 *
 *   GET www.okx.com/api/v5/copytrading/
 *     public-lead-traders?instType&sortType&page&limit=20&dataVer
 *         board, ~10 pages × 20; rank metrics are LAST-90-DAY figures
 *         (docs) → timeframes_native=[90], 7/30 are DERIVED boards from
 *         Tier-B profile stats (MEXC/BTCC pattern). dataVer from page 1
 *         is pinned across pages = consistent snapshot under pagination
 *         (probed 2026-11-15: an older retained dataVer is served and
 *         echoed as that version; an unknown one falls back to the current
 *         version and echoes it). The board reports totalPage (a string),
 *         never a row total, so Tier-A proves it complete by exhaustion.
 *     public-stats?uniqueCode&lastDays            1/2/3 = 7/30/90 days
 *         (verified: profitDays+lossDays sum to exactly 7/30/90)
 *     public-pnl?uniqueCode&lastDays              daily cumulative pnl +
 *         pnlRatio series, newest-first, window start = 0
 *     public-preference-currency?uniqueCode       traded-coin ratios
 *     public-current-subpositions?uniqueCode      SWAP-only open positions
 *     public-subpositions-history?uniqueCode&after=subPosId
 *                                                 SWAP-only closed positions
 *     public-copy-traders?uniqueCode              SWAP-only aggregate + top-10
 *
 * IMPORTANT: those three record endpoints document only instType=SWAP.
 * Sending SPOT returns HTTP 400 / code 51000. Omitting instType is worse:
 * OKX defaults to SWAP, and many SPOT/SWAP boards share the same uniqueCode,
 * so the response can silently belong to the trader's futures surface.
 *
 * No Tier-B profile capture contract (lib/ingest/profile-capture): none of
 * the above reports a maximum drawdown, and the web's own detail endpoints
 * report none for the requested window either (probe 2026-11-21, pinned by
 * __tests__/profile-capture-contract.test.ts): spot/trade-data `maxRetreat`
 * is one value for every latestNum, and public/max-drawdown is day / week /
 * history per account. The per-window winRatio is already on the board entry.
 *
 * The web's internal priapi (/priapi/v5/ecotrade/public/follow-rank,
 * ~84 pages) has wider membership but is undocumented — noted in
 * sources.meta as a future expansion, NOT used.
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
import { BlockedUpstreamError, isBlockedStatus } from '../../fetch/rate-limiter'
import type { JsonFetcher, NumericLeaderboardPageMeta } from '../../fetch/capture'
import { captureReplayLeaderboard, payloadPath } from '../../fetch/replay-capture'
import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
import { assertSourceSurfaceSupported } from '../../core/surface-capabilities'
import {
  parseOkxHistory,
  parseOkxLeaderboardPage,
  parseOkxLeaderboardSeries,
  parseOkxPositions,
  parseOkxProfile,
} from './parsers'
import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  type HistoryTerminalClaim,
} from '../../history-acquisition'
import { okxPositionHistoryTerminalVerifier } from './history-terminal'

const API_BASE = 'https://www.okx.com/api/v5/copytrading'
const PAGE_LIMIT = 20 // public-lead-traders hard max
const MAX_BOARD_PAGES = 60 // board is ~10 pages; hard safety cap
const BOARD_HEADERS = {
  accept: 'application/json',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

/**
 * Exhausted-completeness contract for okx_futures and okx_spot (registered
 * per source in arena.leaderboard_exhaustion_contracts). The envelope wraps
 * the board in a one-item `data` array: the board ends at the reported
 * totalPage, and the dataVer token pins one snapshot across every page.
 */
export const OKX_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted' as const,
  list_path: ['data', '0', 'ranks'],
  row_key_path: ['uniqueCode'],
  end_signal: { kind: 'page_count' as const, path: ['data', '0', 'totalPage'] },
  board_version: { kind: 'token' as const, path: ['data', '0', 'dataVer'] },
  max_duplicate_rows: 0,
})
const DEFAULT_HISTORY_MAX_PAGES = 5

/** lastDays param: 1/2/3 = last 7/30/90 days (4=180d is not an Arena TF). */
const LAST_DAYS: Record<number, string> = { 7: '1', 30: '2', 90: '3', 0: '3' }

type Dict = Record<string, unknown>

function base(src: SourceRow): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints.base ?? API_BASE
}

type OkxInstType = 'SPOT' | 'SWAP'

/** SPOT | SWAP — explicit in meta, defaulted from product_type, fail-closed. */
function instType(src: SourceRow): OkxInstType {
  const configured = String(
    src.meta.inst_type ?? (src.product_type === 'spot' ? 'SPOT' : 'SWAP')
  ).toUpperCase()
  if (configured !== 'SPOT' && configured !== 'SWAP') {
    throw new Error(`[okx] invalid inst_type "${configured}" for source ${src.slug}`)
  }
  return configured
}

/** Public record surfaces are documented and live-verified as SWAP-only. */
function supportsSwapRecords(src: SourceRow): boolean {
  // Require both canonical dimensions. This prevents a bad SPOT source meta
  // override from routing a shared uniqueCode into the default SWAP surface.
  return src.product_type === 'futures' && instType(src) === 'SWAP'
}

/** Paced plain-HTTP GET; OKX envelopes everything as {code,data,msg}. */
async function fetchData(session: FetchSession, url: string): Promise<Dict[]> {
  return session.paced(async () => {
    const res = await fetch(url, { headers: BOARD_HEADERS })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[okx] HTTP ${res.status} from ${url}`)
    const payload = (await res.json()) as { code?: unknown; data?: unknown; msg?: unknown }
    if (payload.code !== '0') {
      throw new Error(`[okx] API code ${String(payload.code)} (${String(payload.msg)}) from ${url}`)
    }
    return Array.isArray(payload.data) ? (payload.data as Dict[]) : []
  })
}

/** Capture fetcher: no pacing or status throw (the capture records both). */
const fetchBoardJson: JsonFetcher = async (template) => {
  const response = await fetch(template.url, { headers: template.headers })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // A non-JSON answer stays null; page validation records it as an upstream error.
  }
  return { status: response.status, json }
}

function boardBlock(payload: unknown): Dict {
  const root = (payload ?? {}) as { code?: unknown; data?: unknown }
  if (root.code !== '0') {
    throw new TypeError(`[okx] leaderboard response code ${JSON.stringify(root.code)} is not "0"`)
  }
  if (!Array.isArray(root.data) || root.data.length !== 1) {
    throw new TypeError('[okx] leaderboard response must wrap exactly one board block in data')
  }
  const block: unknown = root.data[0]
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    throw new TypeError('[okx] leaderboard board block must be an object')
  }
  return block as Dict
}

/** Upstream page meta: OKX reports pages, never rows (exhausted mode). */
function okxLeaderboardMeta(payload: unknown): NumericLeaderboardPageMeta {
  const block = boardBlock(payload)
  if (!Array.isArray(block.ranks)) {
    throw new TypeError('[okx] leaderboard response must contain data[0].ranks')
  }
  if (block.ranks.length > PAGE_LIMIT) {
    throw new TypeError(`[okx] leaderboard page holds more than ${PAGE_LIMIT} rows`)
  }
  const totalPage = Number(block.totalPage)
  if (!Number.isSafeInteger(totalPage) || totalPage < 1 || totalPage > MAX_BOARD_PAGES) {
    throw new TypeError(`[okx] leaderboard totalPage must be 1..${MAX_BOARD_PAGES}`)
  }
  return {
    rowCount: block.ranks.length,
    reportedPopulation: null,
    reportedPageCount: null, // the declared end signal (data.0.totalPage) is the page count
    reportedCurrentPage: null,
    reportedPageSize: null,
  }
}

function pinnedDataVer(firstPagePayload: unknown): string {
  const dataVer = payloadPath(firstPagePayload, ['data'])
  const value = Array.isArray(dataVer) ? (dataVer[0] as Dict | undefined)?.dataVer : undefined
  if (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value)) {
    throw new TypeError('[okx] page one did not report a pinnable dataVer')
  }
  return value
}

// ── Preference-currency, memoized per (session, trader) — TF-independent ──

const prefCache = new WeakMap<FetchSession, Map<string, Promise<Dict[]>>>()

function getPreference(session: FetchSession, src: SourceRow, code: string): Promise<Dict[]> {
  let perSession = prefCache.get(session)
  if (!perSession) {
    perSession = new Map()
    prefCache.set(session, perSession)
  }
  let cached = perSession.get(code)
  if (!cached) {
    cached = fetchData(
      session,
      `${base(src)}/public-preference-currency?instType=${instType(src)}&uniqueCode=${code}`
    )
    perSession.set(code, cached)
    cached.catch(() => perSession!.delete(code))
  }
  return cached
}

const okxAdapter: SourceAdapter = {
  slug: 'okx',
  capabilities: {
    profile: true, // public-stats + public-pnl + preference-currency
    positions: true, // public-current-subpositions (SWAP sources only)
    positionHistory: true, // public-subpositions-history (SWAP sources only)
    orders: false, // not exposed publicly
    transfers: false,
    copiers: true, // public-copy-traders (SWAP sources only)
  },

  supportsSurface(src, surface) {
    if (surface === 'positions' || surface === 'positionHistory' || surface === 'copiers') {
      return supportsSwapRecords(src)
    }
    return true
  },

  historyTerminalVerifier(src, kind) {
    return src.slug === 'okx_futures' &&
      kind === 'position_history' &&
      supportsSwapRecords(src) &&
      base(src) === API_BASE
      ? okxPositionHistoryTerminalVerifier
      : null
  },

  /**
   * 90d native board only (7/30 are derived downstream). Pages 1..totalPage,
   * page 2+ pinned to page one's dataVer. Each RAW page is the upstream
   * response verbatim; Tier-A dedupes by uniqueCode and the exhaustion proof
   * refuses any cross-page duplicate or version change.
   */
  async captureLeaderboard(session, src, timeframe, options) {
    if (timeframe !== 90) {
      throw new Error(`[okx] ${timeframe}d board is derived, not natively listed`)
    }
    if (src.page_size !== null && src.page_size !== PAGE_LIMIT) {
      throw new TypeError(`[okx] source page_size must be ${PAGE_LIMIT} (the upstream limit)`)
    }
    const sortType = String(src.meta.sort_type ?? 'overview')
    const listUrl = `${base(src)}/public-lead-traders`
    const it = instType(src)
    return captureReplayLeaderboard(
      { session, fetcher: fetchBoardJson, src, label: 'okx', signal: options?.signal },
      {
        buildRequest: (pageIndex, { firstPagePayload }) => ({
          url:
            `${listUrl}?instType=${it}&sortType=${encodeURIComponent(sortType)}` +
            `&limit=${PAGE_LIMIT}&page=${pageIndex}` +
            (pageIndex === 1 ? '' : `&dataVer=${pinnedDataVer(firstPagePayload)}`),
          method: 'GET',
          headers: BOARD_HEADERS,
        }),
        publicRequest: { query: ['instType', 'sortType', 'limit', 'page', 'dataVer'] },
        pageBinding: { location: 'query', key: 'page' },
        extractMeta: okxLeaderboardMeta,
        pageSize: PAGE_LIMIT,
        exhaustion: OKX_LEADERBOARD_EXHAUSTION,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await okxAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
  },

  /**
   * Profile bundle per TF: stats + daily pnl/roi series (lastDays-mapped)
   * + preference-currency (memoized — TF-independent, 3 TFs cost one).
   * The composite payload embeds the timeframe so parseProfile stays pure.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const lastDays = LAST_DAYS[timeframe] ?? '3'
    const it = instType(src)
    const statsUrl = `${base(src)}/public-stats?instType=${it}&uniqueCode=${exchangeTraderId}&lastDays=${lastDays}`
    const stats = await fetchData(session, statsUrl)
    const pnl = await fetchData(
      session,
      `${base(src)}/public-pnl?instType=${it}&uniqueCode=${exchangeTraderId}&lastDays=${lastDays}`
    )
    const preference = await getPreference(session, src, exchangeTraderId).catch(() => [])

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            timeframe: timeframe === 0 ? 90 : timeframe,
            stats: { data: stats },
            pnl: { data: pnl },
            preference: { data: preference },
          },
          url: statsUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  /** Tier D: open lead positions, fresh each call. */
  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    assertSourceSurfaceSupported(okxAdapter, src, 'positions')
    // NOTE: public-current-subpositions rejects a `limit` param with HTTP 400
    // (verified 2026-07-03 — the &limit=500 here silently 0'd every okx open
    // position). It returns the full current set unpaginated; no limit needed.
    const url =
      `${base(src)}/public-current-subpositions?instType=${instType(src)}` +
      `&uniqueCode=${exchangeTraderId}`
    const data = await fetchData(session, url)
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload: { data }, url, fetchedAt }], fetchedAt }
  },

  /**
   * position_history: newest→oldest via after=subPosId; stops on cursor
   * overlap (oldest openTime ≤ stored ISO cursor), exhaustion, or the
   * meta.history_max_pages cap. copiers: one aggregate+top-10 response.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncGenerator<RawPage, HistoryTerminalClaim | undefined, void> {
    const it = instType(src)
    if (kind === 'copiers') {
      assertSourceSurfaceSupported(okxAdapter, src, 'copiers')
      const url = `${base(src)}/public-copy-traders?instType=${it}&uniqueCode=${exchangeTraderId}`
      const data = await fetchData(session, url)
      yield { pageIndex: 1, payload: { data }, url, fetchedAt: new Date().toISOString() }
      return undefined
    }
    if (kind !== 'position_history') {
      throw new Error(`[okx] history surface ${kind} not supported`)
    }
    assertSourceSurfaceSupported(okxAdapter, src, 'positionHistory')

    const maxPages =
      Number(src.meta.history_max_pages ?? DEFAULT_HISTORY_MAX_PAGES) || DEFAULT_HISTORY_MAX_PAGES
    const cursorMs = cursor ? Date.parse(cursor) : NaN
    let after: string | null = null
    for (let page = 1; page <= maxPages; page++) {
      const url =
        `${base(src)}/public-subpositions-history?instType=${it}` +
        `&uniqueCode=${encodeURIComponent(exchangeTraderId)}&limit=100` +
        (after ? `&after=${encodeURIComponent(after)}` : '')
      const data = await fetchData(session, url)
      yield {
        pageIndex: page,
        payload: { data, historyTraderIdentity: exchangeTraderId },
        url,
        fetchedAt: new Date().toISOString(),
      }
      if (data.length === 0) {
        return {
          contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
          observations: [{ segment_id: 'default', reason: 'empty_page', page_ordinal: page }],
        }
      }

      const last = data[data.length - 1]
      const lastId = String(last.subPosId ?? '')
      if (!lastId) {
        throw new Error('[okx] position history page is missing the pagination subPosId')
      }
      if (Number.isFinite(cursorMs)) {
        // The persisted position-history cursor is a close timestamp. Compare
        // it with the same source field; using openTime can stop early for a
        // long-lived position that opened before, but closed after, the
        // checkpoint.
        const closeTimes = data
          .map((row) => Number(row.closeTime))
          .filter((closeTime) => Number.isFinite(closeTime) && closeTime > 0)
        const oldest = closeTimes.length > 0 ? Math.min(...closeTimes) : Number.NaN
        // Overlap reached: this page already dips into stored close history.
        if (Number.isFinite(oldest) && oldest <= cursorMs) {
          return {
            contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
            observations: [{ segment_id: 'default', reason: 'cursor_overlap', page_ordinal: page }],
          }
        }
      }
      after = lastId
    }
    throw new Error(
      `[okx] position history reached page cap ${maxPages} without exhaustion or cursor overlap`
    )
  },

  parseLeaderboard: parseOkxLeaderboardPage,
  parseLeaderboardSeries: parseOkxLeaderboardSeries,
  parseProfile: parseOkxProfile,
  parsePositions: parseOkxPositions,
  parseHistory: parseOkxHistory,
}

registerAdapter(okxAdapter)

export { okxAdapter }
