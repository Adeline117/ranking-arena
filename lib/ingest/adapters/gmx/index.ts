/**
 * GMX on-chain adapter (spec §7 #32 — "same pattern as Hyperliquid").
 *
 * PURE HTTP — no Playwright. The Squids subgraph (the same backend the
 * app.gmx.io leaderboard uses; legacy Satsuma DNS is dead since 2026-03)
 * answers everything; plain fetch() under session.paced() keeps the rate
 * budget + circuit accounting without ever launching a browser.
 *
 * Surfaces:
 *   Tier A  POST {subgraph} periodAccountStats(where:{from, maxCapital_gte})
 *           — ONE query per TF returns every account active in the window
 *           (~3k for 7d). The resolver requires `from` rounded to 00:00:00
 *           UTC and a window STRICTLY <90 days, so the 90d board uses an
 *           89-day from (disclosed via payload.from). 90 is NATIVE — no
 *           derive-boards needed (sources row updated accordingly).
 *           Unsorted → sort by realized-basis window PnL desc, truncate to
 *           meta.board_depth (default 60 = survey count), chunk page_size.
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
  gmxRealizedPnlUsd,
  parseGmxHistory,
  parseGmxLeaderboardPage,
  parseGmxPositions,
  parseGmxProfile,
} from './parsers'

/** Official production GraphQL endpoint published by GMX. */
export const GMX_SUBGRAPH_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const TOKENS_URL = 'https://arbitrum-api.gmxinfra.io/tokens'

const DEFAULT_BOARD_DEPTH = 60 // survey count (spec §7 #32: 20 × 3 pages)
const BOARD_FETCH_LIMIT = 50_000 // resolver computes server-side; one shot

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
 * Window start per TF: midnight-aligned (resolver hard requirement) and
 * STRICTLY <90 days back — so the "90d" board is an 89-day window
 * (midnight − 89d spans 89.0–89.99 days at query time).
 */
export function gmxWindowFrom(timeframe: RankingTimeframe, nowMs: number): number {
  const midnight = Math.floor(nowMs / 86_400_000) * 86_400
  const days = timeframe === 90 ? 89 : timeframe
  return midnight - days * 86_400
}

/** Effective board depth: meta.board_depth (production knob, default 60),
 *  further capped by meta.max_rows (smoke-run knob). */
function effectiveDepth(src: SourceRow): number {
  const boardDepth = Number(src.meta.board_depth) || DEFAULT_BOARD_DEPTH
  const maxRows = Number(src.meta.max_rows) || null
  return maxRows !== null ? Math.min(boardDepth, maxRows) : boardDepth
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

  /**
   * One periodAccountStats query per TF → sort by realized-basis PnL desc
   * (deterministic tie-breaks) → truncate to the depth knob → chunk into
   * page_size pages. Chunk-local ranks are re-anchored by the Tier-A
   * processor via (pageIndex−1)×page_size.
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const from = gmxWindowFrom(timeframe, Date.now())
    const data = await gql<{ periodAccountStats: Dict[] }>(
      session,
      src,
      `query { periodAccountStats(limit: ${BOARD_FETCH_LIMIT}, ` +
        `where: { from: ${from}, maxCapital_gte: "0" }) { ${PERIOD_FIELDS} } }`
    )
    const rows = data.periodAccountStats ?? []
    const fetchedAt = new Date().toISOString()

    const sorted = [...rows].sort((a, b) => {
      const pa = gmxRealizedPnlUsd(a) ?? 0
      const pb = gmxRealizedPnlUsd(b) ?? 0
      if (pb !== pa) return pb - pa
      return String(a.id ?? '').localeCompare(String(b.id ?? ''))
    })
    const truncated = sorted.slice(0, effectiveDepth(src))

    const chunkSize = src.page_size ?? 20
    for (let i = 0; i < truncated.length; i += chunkSize) {
      yield {
        pageIndex: Math.floor(i / chunkSize) + 1,
        payload: {
          timeframe,
          from,
          reportedTotal: rows.length, // pre-truncation account count
          rows: truncated.slice(i, i + chunkSize),
        },
        url: endpoint(src, 'subgraph', GMX_SUBGRAPH_URL),
        fetchedAt,
      }
    }
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
    const from = gmxWindowFrom(tf, Date.now())
    const account = checksum(exchangeTraderId)

    const periodStats = await gql<{ periodAccountStats: Dict[] }>(
      session,
      src,
      `query { periodAccountStats(where: { id_eq: "${account}", from: ${from} }) ` +
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
            positions: data.positions ?? [],
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
