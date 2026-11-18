/**
 * GMX on-chain adapter (spec §7 #32 — "same pattern as Hyperliquid").
 *
 * PURE HTTP — no Playwright. The Squids subgraph (the same backend the
 * app.gmx.io leaderboard uses; legacy Satsuma DNS is dead since 2026-03)
 * answers everything; plain fetch() under session.paced() keeps the rate
 * budget + circuit accounting without ever launching a browser.
 *
 * Surfaces:
 *   Tier A  POST {subgraph} periodAccountStats(where:{from, to, maxCapital_gte})
 *           — ONE query per TF returns every account active in the window
 *           (~2.5k/3.3k/4.9k for 7d/30d/90d). The resolver requires `from`
 *           rounded to 00:00:00 UTC. Arena passes BOTH `from` and `to`, so
 *           7d/30d/90d each cover an exact number of completed UTC days. This
 *           is at most 24h behind a rolling-now window and is disclosed in
 *           every RAW/stat payload. Attempt-bound capture (manifest v3,
 *           exhausted mode): the verbatim response is the one source page, the
 *           full population is published, and the parser orders it by
 *           realized-basis window PnL desc.
 *   Tier B/C POST periodAccountStats(id_eq) + accountPnlHistoryStats — both
 *           per (trader, TF). IDs are CASE-SENSITIVE checksummed addresses
 *           (lowercase id_eq returns []) → viem getAddress() at fetch time.
 *   Tier D  POST positions(account_eq, isSnapshot_eq:false) + session-
 *           memoized markets + gmxinfra tokens (symbol/decimals resolution
 *           embedded into the RAW payload so parsing stays pure, §5.5).
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import { getAddress } from 'viem'
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
import {
  captureNumericLeaderboard,
  type JsonFetcher,
  type LeaderboardCapture,
  type LeaderboardPublicRequestProjectionInput,
  type NumericLeaderboardPageMeta,
} from '../../fetch/capture'
import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
import { ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT } from '../../acquisition-attempts'
import {
  gmxWindowEchoAlias,
  parseGmxHistory,
  parseGmxLeaderboardPage,
  parseGmxPositions,
  parseGmxProfile,
  readGmxWindowEcho,
} from './parsers'

export { sortGmxLeaderboardRows } from './parsers'

/** Official production GraphQL endpoint published by GMX. */
export const GMX_SUBGRAPH_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const TOKENS_URL = 'https://arbitrum-api.gmxinfra.io/tokens'

/** All PeriodAccountStatObject fields — raw keeps everything (spec §3). */
const PERIOD_FIELDS =
  'id realizedPnl realizedFees realizedSwapFees realizedPriceImpact ' +
  'realizedSwapImpact startUnrealizedPnl startUnrealizedFees ' +
  'startUnrealizedPriceImpact netCapital maxCapital sumMaxSize volume ' +
  'cumsumSize cumsumCollateral closedCount wins losses'

type Dict = Record<string, unknown>

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** Paced plain-HTTP request; 401/403/429 feed the gate's backoff. */
async function fetchJson(
  session: FetchSession,
  url: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown }
): Promise<unknown> {
  return session.paced(async () => {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers:
        init?.body !== undefined
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[gmx] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

async function gql<T>(session: FetchSession, src: SourceRow, query: string): Promise<T> {
  const url = endpoint(src, 'subgraph', GMX_SUBGRAPH_URL)
  const payload = (await fetchJson(session, url, { method: 'POST', body: { query } })) as {
    data?: T
    errors?: Array<{ message?: string }>
  }
  if (payload.errors?.length) {
    throw new Error(`[gmx] subgraph error: ${payload.errors[0]?.message ?? 'unknown'}`)
  }
  if (payload.data === undefined) throw new Error('[gmx] subgraph returned no data')
  return payload.data
}

/**
 * Exact completed-UTC-day bounds. An explicit midnight `to` makes 90d valid;
 * omitting it makes the resolver compare against now and reject the boundary.
 */
export function gmxWindowBounds(
  timeframe: RankingTimeframe,
  nowMs: number
): { from: number; to: number } {
  const to = Math.floor(nowMs / 86_400_000) * 86_400
  return { from: to - timeframe * 86_400, to }
}

export function gmxWindowFrom(timeframe: RankingTimeframe, nowMs: number): number {
  return gmxWindowBounds(timeframe, nowMs).from
}

// ── Tier A: attempt-bound capture ──

/**
 * Upstream `limit` of the one board request, and the source's page_size. The
 * resolver answers the whole window in one unsorted response (live
 * 2026-11-18: 2,516 / 3,274 / 4,920 accounts for 7d/30d/90d), so a response
 * shorter than the limit is the end of the population (short_page). A full
 * response could hide more accounts; the capture then stops at the caller cap
 * and the attempt can never verify.
 */
export const GMX_LEADERBOARD_PAGE_SIZE = 50_000

/**
 * Exhausted completeness (no reported total). Mirrored by
 * arena.leaderboard_exhaustion_contracts for `gmx`. Row order is stable for
 * a completed-day window (verified live: identical ids and values on repeat),
 * so a first-page re-read proves the board did not move during the capture.
 */
export const GMX_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted',
  list_path: ['data', 'periodAccountStats'],
  row_key_path: ['id'],
  end_signal: Object.freeze({ kind: 'short_page' }),
  board_version: Object.freeze({ kind: 'first_page_reread' }),
  max_duplicate_rows: 0,
}) as LeaderboardExhaustionDeclaration

/**
 * Public request body: the GraphQL document and a request ordinal in
 * `extensions` (the GraphQL-over-HTTP map for client metadata, ignored by the
 * server). The subgraph has no page argument; the ordinal binds the capture's
 * page index, and the document's offset is (ordinal − 1) × limit.
 */
export const GMX_LEADERBOARD_PAGE_BINDING = Object.freeze({
  location: 'body' as const,
  path: ['extensions', 'arenaPage'],
})

export function buildGmxLeaderboardRequestBody(input: {
  timeframe: RankingTimeframe
  from: number
  to: number
  pageIndex: number
  pageSize: number
}): { query: string; extensions: { arenaPage: number } } {
  const { timeframe, from, to, pageIndex, pageSize } = input
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) {
    throw new TypeError('[gmx] leaderboard page index must be a positive safe integer')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new TypeError('[gmx] leaderboard page size must be a positive safe integer')
  }
  const offset = (pageIndex - 1) * pageSize
  return {
    query:
      `query ArenaGmxLeaderboard { ${gmxWindowEchoAlias(timeframe, from, to)}: __typename ` +
      `periodAccountStats(limit: ${pageSize}, offset: ${offset}, ` +
      `where: { from: ${from}, to: ${to}, maxCapital_gte: "0" }) { ${PERIOD_FIELDS} } }`,
    extensions: { arenaPage: pageIndex },
  }
}

/** Exact public projection: the body has no credential and is kept whole. */
export function projectGmxLeaderboardRequest(request: {
  method: string
  url: string
  body?: unknown
}): LeaderboardPublicRequestProjectionInput {
  if (request.method !== 'POST') throw new TypeError('[gmx] leaderboard request must be POST')
  const url = new URL(request.url)
  if ([...url.searchParams].length > 0) {
    throw new TypeError('[gmx] leaderboard endpoint must not contain query parameters')
  }
  const body = request.body as Dict | null | undefined
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).sort().join(',') !== 'extensions,query' ||
    typeof body.query !== 'string'
  ) {
    throw new TypeError('[gmx] leaderboard request body must be exactly { query, extensions }')
  }
  return { method: 'POST', url: url.href, body: { query: body.query, extensions: body.extensions } }
}

/**
 * Page meta of one verbatim response. GraphQL errors arrive with HTTP 200, so
 * an `errors` array, a missing list, or a window echo other than the one
 * requested is an upstream error, never an empty board.
 */
export function gmxLeaderboardMeta(
  payload: unknown,
  expected: { timeframe: RankingTimeframe; from: number; to: number }
): NumericLeaderboardPageMeta {
  const root = payload as Dict | null
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new TypeError('[gmx] leaderboard response must be a JSON object')
  }
  if (Array.isArray(root.errors) && root.errors.length > 0) {
    throw new TypeError('[gmx] leaderboard response carries GraphQL errors')
  }
  const data = root.data as Dict | null | undefined
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('[gmx] leaderboard response has no data object')
  }
  const window = readGmxWindowEcho(data)
  if (
    window.timeframe !== expected.timeframe ||
    window.from !== expected.from ||
    window.to !== expected.to
  ) {
    throw new TypeError('[gmx] leaderboard response echoes a different window')
  }
  if (!Array.isArray(data.periodAccountStats)) {
    throw new TypeError('[gmx] leaderboard response must contain data.periodAccountStats')
  }
  return {
    rowCount: data.periodAccountStats.length,
    reportedPopulation: null,
    reportedPageCount: null,
    reportedCurrentPage: null,
    reportedPageSize: null,
  }
}

/** Plain POST; capture paces it and records every status it answers. */
const fetchGmxLeaderboardJson: JsonFetcher = async (template) => {
  const response = await fetch(template.url, {
    method: template.method,
    headers: template.headers,
    body: JSON.stringify(template.body),
  })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // Non-JSON body: capture records the status and validation fails closed.
  }
  return { status: response.status, json }
}

/**
 * One request per TF for the exact completed-UTC-day window, re-read once for
 * board stability. The bounds are fixed before the first request, so the
 * re-read asks for the same window even across midnight.
 */
async function captureGmxLeaderboard(
  session: FetchSession,
  src: SourceRow,
  timeframe: RankingTimeframe,
  options?: { signal?: AbortSignal }
): Promise<LeaderboardCapture> {
  if (src.page_size !== GMX_LEADERBOARD_PAGE_SIZE) {
    throw new TypeError(
      `[gmx] leaderboard capture requires page_size ${GMX_LEADERBOARD_PAGE_SIZE} (got ${src.page_size})`
    )
  }
  const pageSize = GMX_LEADERBOARD_PAGE_SIZE
  const { from, to } = gmxWindowBounds(timeframe, Date.now())
  const url = endpoint(src, 'subgraph', GMX_SUBGRAPH_URL)
  return captureNumericLeaderboard({
    session,
    fetcher: fetchGmxLeaderboardJson,
    signal: options?.signal,
    buildRequest: (pageIndex) => ({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: buildGmxLeaderboardRequestBody({ timeframe, from, to, pageIndex, pageSize }),
    }),
    projectPublicRequest: projectGmxLeaderboardRequest,
    pageBinding: GMX_LEADERBOARD_PAGE_BINDING,
    extractMeta: (payload) => gmxLeaderboardMeta(payload, { timeframe, from, to }),
    pageSize,
    exhaustion: GMX_LEADERBOARD_EXHAUSTION,
    // Ranks are assigned over the whole response; a second page would need a
    // cross-page sort, so a full first page ends the capture unverified.
    callerPageCap: 1,
  })
}

// ── Session-memoized markets + tokens (symbol resolution for positions) ──

interface SymbolMaps {
  markets: Array<{ id: string; indexToken: string }>
  tokens: Array<{ symbol: string; address: string; decimals: number }>
}

const symbolMapCache = new WeakMap<FetchSession, Promise<SymbolMaps>>()

function getSymbolMaps(session: FetchSession, src: SourceRow): Promise<SymbolMaps> {
  let cached = symbolMapCache.get(session)
  if (!cached) {
    cached = (async () => {
      const markets = await gql<{ markets: SymbolMaps['markets'] }>(
        session,
        src,
        'query { markets(limit: 1000) { id indexToken } }'
      )
      const tokensPayload = (await fetchJson(session, endpoint(src, 'tokens', TOKENS_URL))) as {
        tokens?: SymbolMaps['tokens']
      }
      return { markets: markets.markets ?? [], tokens: tokensPayload.tokens ?? [] }
    })()
    symbolMapCache.set(session, cached)
    cached.catch(() => symbolMapCache.delete(session)) // never memoize a failure
  }
  return cached
}

/** Subgraph ids are case-sensitive checksummed addresses (verified live:
 *  lowercase id_eq returns []); tolerate bad input by passing it through. */
function checksum(address: string): string {
  try {
    return getAddress(address)
  } catch {
    return address
  }
}

const gmxAdapter: SourceAdapter = {
  slug: 'gmx',
  capabilities: {
    profile: true, // periodAccountStats(id_eq) + accountPnlHistoryStats
    positions: true, // positions(account_eq, isSnapshot_eq: false)
    positionHistory: false, // would need positionChanges replay — out of v1
    orders: false,
    transfers: false,
    copiers: false, // DEX — no copy trading
  },

  leaderboardAcquisitionContract: ATTEMPT_BOUND_LEADERBOARD_ACQUISITION_CONTRACT,
  captureLeaderboard: captureGmxLeaderboard,

  /** Legacy stream view of the attempt-bound capture (one verbatim page). */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await captureGmxLeaderboard(session, src, timeframe)
    yield* capture.parsePages
  },

  /** Profile bundle: 2 subgraph queries for the SAME midnight-aligned
   *  window the boards use. The composite payload embeds timeframe+from so
   *  parseProfile stays a pure function of stored RAW (spec §5.5). */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const { from, to } = gmxWindowBounds(tf, Date.now())
    const account = checksum(exchangeTraderId)

    const periodStats = await gql<{ periodAccountStats: Dict[] }>(
      session,
      src,
      `query { periodAccountStats(where: { id_eq: "${account}", from: ${from}, to: ${to} }) ` +
        `{ ${PERIOD_FIELDS} } }`
    )
    const pnlHistory = await gql<{ accountPnlHistoryStats: Dict[] }>(
      session,
      src,
      `query { accountPnlHistoryStats(account: "${account}", from: ${from}) ` +
        '{ timestamp pnl cumulativePnl realizedPnl cumulativeRealizedPnl unrealizedPnl } }'
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            periodStats: periodStats.periodAccountStats ?? [],
            pnlHistory: pnlHistory.accountPnlHistoryStats ?? [],
            timeframe: tf,
            from,
            to,
            windowSemantics: 'completed_utc_days',
          },
          url: endpoint(src, 'subgraph', GMX_SUBGRAPH_URL),
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  /** Tier D: live (non-snapshot) positions + the symbol maps embedded so
   *  the stored RAW re-parses without network access. */
  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    const account = checksum(exchangeTraderId)
    const data = await gql<{ positions: Dict[] }>(
      session,
      src,
      `query { positions(limit: 200, where: { account_eq: "${account}", isSnapshot_eq: false }) ` +
        '{ id positionKey account market collateralToken isLong collateralAmount ' +
        'sizeInTokens sizeInUsd realizedPnl maxSize entryPrice leverage ' +
        'unrealizedPnl unrealizedFees openedAt isSnapshot } }'
    )
    const maps = await getSymbolMaps(session, src)
    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            positions: data.positions,
            markets: maps.markets,
            tokens: maps.tokens,
          },
          url: endpoint(src, 'subgraph', GMX_SUBGRAPH_URL),
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async *getHistory(
    _session: FetchSession,
    _src: SourceRow,
    _exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    throw new Error(`[gmx] history surface ${kind} not supported`)
  },

  parseLeaderboard: parseGmxLeaderboardPage,
  parseProfile: parseGmxProfile,
  parsePositions: parseGmxPositions,
  parseHistory: parseGmxHistory,
}

registerAdapter(gmxAdapter)

export { gmxAdapter }
