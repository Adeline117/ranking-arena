/**
 * gTrade (Gains Network) on-chain adapter (spec §7 #34, §11.20).
 *
 * PURE HTTP — no Playwright. The gains.trade leaderboard is backed by
 * backend-global.gains.trade (verified by live capture 2026-06-12; the
 * legacy backend-arbitrum /leaderboard endpoint is dead since 2026-04).
 *
 * Surfaces:
 *   Tier A  GET {base}/api/leaderboard/all?chainId — ONE response carries
 *           ALL TF boards keyed "1"/"7"/"30"/"90" (the site's #7/#30/#90
 *           URL hashes select client-side) → memoized per session so the
 *           three TF crawls share a single download. 25 rows per TF.
 *   Tier B/C GET /api/personal-trading-history/{addr}/stats (lifetime) +
 *           /api/personal-trading-history/{addr}?cursor (trades table,
 *           newest→oldest, id cursor) — per-TF stats are aggregated BY US
 *           from the trades table (spec §11.20); the trades crawl is
 *           memoized per (session, trader) so 3 TFs cost one crawl.
 *   orders  The same trades table as an append-only history surface.
 *
 * Chain: meta.chain_id (default 42161 / Arbitrum — the main gTrade chain;
 * Polygon/Base boards would be separate sources rows).
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
import {
  registerAdapter,
  type ProfileFetchIntent,
  type ProfileFetchOptions,
  type SourceAdapter,
} from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { BlockedUpstreamError, isBlockedStatus } from '../../fetch/rate-limiter'
import {
  parseGtradeHistory,
  parseGtradeLeaderboardPage,
  parseGtradePositions,
  parseGtradeProfile,
  unmatchedGtradeCloseKeys,
} from './parsers'
import {
  fetchGtradeTradesWindow,
  GtradeTradesFetchError,
  type GtradeTradesSnapshot,
} from './trades-fetch'

const API_BASE = 'https://backend-global.gains.trade/api'
const DEFAULT_PROFILE_TRADES_MAX_PAGES = 25
const INTERACTIVE_PROFILE_TRADES_MAX_PAGES = 5

type Dict = Record<string, unknown>

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function chainId(src: SourceRow): string {
  return String(src.meta.chain_id ?? '42161')
}

/** Paced plain-HTTP GET; 401/403/429 feed the gate's backoff. */
async function fetchJson(session: FetchSession, url: string): Promise<unknown> {
  return session.paced(async () => {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[gtrade] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

// ── Board download, memoized per session (one GET serves all 3 TFs) ──

interface BoardFetch {
  byTf: Record<string, Dict[]>
  fetchedAt: string
  url: string
}

const boardCache = new WeakMap<FetchSession, Promise<BoardFetch>>()

function getBoard(session: FetchSession, src: SourceRow): Promise<BoardFetch> {
  let cached = boardCache.get(session)
  if (!cached) {
    const url = `${endpoint(src, 'leaderboard', `${API_BASE}/leaderboard/all`)}?chainId=${chainId(src)}`
    cached = fetchJson(session, url).then((payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`[gtrade] unexpected leaderboard shape from ${url}`)
      }
      return {
        byTf: payload as Record<string, Dict[]>,
        fetchedAt: new Date().toISOString(),
        url,
      }
    })
    boardCache.set(session, cached)
    cached.catch(() => boardCache.delete(session)) // never memoize a failure
  }
  return cached
}

// ── Trades crawl, memoized per (session, trader) — 3 TFs share one crawl ──

interface TradesOutcome {
  state: 'fetched' | 'failed'
  snapshot: GtradeTradesSnapshot
  reason: string
}

const tradesCache = new WeakMap<FetchSession, Map<string, Promise<TradesOutcome>>>()

/**
 * Crawl a frozen trades-table snapshot newest→oldest until it strictly
 * covers 90 days, exhausts, or reaches the configured page cap.
 */
function getTrades(
  session: FetchSession,
  src: SourceRow,
  address: string,
  maxPages: number
): Promise<TradesOutcome> {
  let perSession = tradesCache.get(session)
  if (!perSession) {
    perSession = new Map()
    tradesCache.set(session, perSession)
  }
  const cacheKey = `${address}:${maxPages}`
  let cached = perSession.get(cacheKey)
  if (!cached) {
    const asOfTimeMs = Date.now()
    const base = endpoint(src, 'history', `${API_BASE}/personal-trading-history`)
    cached = (async () => {
      try {
        const snapshot = await fetchGtradeTradesWindow(
          async (cursor, limit) => {
            const params = new URLSearchParams({
              chainId: chainId(src),
              limit: String(limit),
              endDate: new Date(asOfTimeMs).toISOString(),
            })
            if (cursor !== null) params.set('cursor', String(cursor))
            const url = `${base}/${address}?${params.toString()}`
            return { payload: await fetchJson(session, url), url }
          },
          asOfTimeMs,
          { maxPages }
        )
        return { state: 'fetched', snapshot, reason: snapshot.meta.stopReason }
      } catch (error) {
        if (error instanceof GtradeTradesFetchError) {
          return { state: 'failed', snapshot: error.partial, reason: error.reason }
        }
        throw error
      }
    })()
    perSession.set(cacheKey, cached)
    cached.catch(() => perSession!.delete(cacheKey))
  }
  return cached
}

const PROFILE_FETCH_INTENTS = new Set<ProfileFetchIntent>([
  'scheduled_full',
  'series_only',
  'interactive_deferred',
])

function requireProfileIntent(options: ProfileFetchOptions | undefined): ProfileFetchIntent {
  const intent = options?.intent
  if (!intent || !PROFILE_FETCH_INTENTS.has(intent)) {
    throw new Error('[gtrade] missing or invalid profile fetch intent')
  }
  return intent
}

const gtradeAdapter: SourceAdapter = {
  slug: 'gtrade',
  capabilities: {
    profile: true, // stats endpoint + trades-table aggregation (spec §11.20)
    positions: false, // open-trades is raw on-chain scaled — out of v1
    // M3-3b: closed positions rebuilt from the trades table (pair+tradeIndex
    // open→close pairing) — same fetch as orders, zero extra requests.
    positionHistory: true,
    orders: true, // the trades table itself
    transfers: false,
    copiers: false, // DEX — no copy trading
  },

  /** The TF key of the memoized all-boards response, sorted (deterministic)
   *  by USD PnL desc, as a single page (each board is 25 rows). */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const board = await getBoard(session, src)
    const rows = Array.isArray(board.byTf[String(timeframe)]) ? board.byTf[String(timeframe)] : []

    const sorted = [...rows].sort((a, b) => {
      const pa = Number(a.total_pnl_usd ?? a.total_pnl) || 0
      const pb = Number(b.total_pnl_usd ?? b.total_pnl) || 0
      if (pb !== pa) return pb - pa
      return String(a.address ?? '').localeCompare(String(b.address ?? ''))
    })
    const maxRows = Number(src.meta.max_rows) || null
    const truncated = maxRows !== null ? sorted.slice(0, maxRows) : sorted

    yield {
      pageIndex: 1,
      payload: { timeframe, rows: truncated, reportedTotal: rows.length },
      url: board.url,
      fetchedAt: board.fetchedAt,
    }
  },

  /** Profile bundle: lifetime stats + the (memoized) trades crawl. The
   *  composite payload embeds the timeframe so parseProfile stays pure. */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe,
    _traderMeta: Record<string, unknown> | null | undefined,
    options: ProfileFetchOptions
  ): Promise<RawBundle> {
    const intent = requireProfileIntent(options)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const base = endpoint(src, 'history', `${API_BASE}/personal-trading-history`)
    const statsUrl = `${base}/${exchangeTraderId}/stats?chainId=${chainId(src)}`
    const stats = await fetchJson(session, statsUrl)
    const configuredMaxPages = Number(
      src.meta.profile_trades_max_pages ?? DEFAULT_PROFILE_TRADES_MAX_PAGES
    )
    const maxPages =
      intent === 'interactive_deferred'
        ? Math.min(configuredMaxPages, INTERACTIVE_PROFILE_TRADES_MAX_PAGES)
        : configuredMaxPages
    const trades = await getTrades(session, src, exchangeTraderId, maxPages)

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            stats,
            // Compatibility envelope for older RAW tooling. The canonical
            // parser ignores it and replays tradesSnapshot.rawPages instead.
            trades: {
              data: trades.snapshot.trades,
              truncated: !trades.snapshot.meta.complete,
            },
            timeframe: tf,
            profileFetchIntent: intent,
            tradesFetchState: trades.state,
            tradesFetchReason: trades.reason,
            tradesFetchMaxPages: maxPages,
            tradesSnapshot: trades.snapshot,
          },
          url: statsUrl,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[gtrade] positions surface not supported')
  },

  /**
   * Reuse the validated profile snapshot in the same session. Orders retain
   * exact upstream pages; position_history gets one composite snapshot so an
   * open/close pair split across page boundaries can be rebuilt atomically.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    // position_history reuses the SAME trades-table pages — the parser regroups
    // them into closed positions (M3-3b); no separate endpoint exists.
    if (kind !== 'orders' && kind !== 'position_history') {
      throw new Error(`[gtrade] history surface ${kind} not supported`)
    }
    const base = endpoint(src, 'history', `${API_BASE}/personal-trading-history`)
    const maxPages = Number(
      src.meta.history_max_pages ??
        src.meta.profile_trades_max_pages ??
        DEFAULT_PROFILE_TRADES_MAX_PAGES
    )
    const outcome = await getTrades(session, src, exchangeTraderId, maxPages)
    const fetchedAt = new Date().toISOString()

    if (kind === 'position_history') {
      yield {
        pageIndex: 1,
        payload: {
          historyFetchState: outcome.state,
          historyFetchReason: outcome.reason,
          historyCursor: cursor,
          tradesSnapshot: outcome.snapshot,
        },
        url: outcome.snapshot.rawPages[0]?.url ?? `${base}/${exchangeTraderId}`,
        fetchedAt,
      }
      if (outcome.state === 'failed') {
        throw new Error(`[gtrade] position history fetch failed: ${outcome.reason}`)
      }
      const unmatched = unmatchedGtradeCloseKeys(outcome.snapshot.trades, cursor)
      if (unmatched.length > 0) {
        throw new Error(
          `[gtrade] position history prefix is missing ${unmatched.length} opening events`
        )
      }
      return
    }

    for (const rawPage of outcome.snapshot.rawPages) {
      yield {
        pageIndex: rawPage.pageIndex,
        payload: rawPage.response,
        url: rawPage.url,
        fetchedAt,
      }
    }
    if (outcome.snapshot.rawPages.length === 0) {
      yield {
        pageIndex: 1,
        payload: {
          historyFetchState: outcome.state,
          historyFetchReason: outcome.reason,
          tradesSnapshot: outcome.snapshot,
        },
        url: `${base}/${exchangeTraderId}`,
        fetchedAt,
      }
    }
    if (outcome.state === 'failed') {
      throw new Error(`[gtrade] orders history fetch failed: ${outcome.reason}`)
    }
  },

  parseLeaderboard: parseGtradeLeaderboardPage,
  parseProfile: parseGtradeProfile,
  parsePositions: parseGtradePositions,
  parseHistory: parseGtradeHistory,
}

registerAdapter(gtradeAdapter)

export { gtradeAdapter }
