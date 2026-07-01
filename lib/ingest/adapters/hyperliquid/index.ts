/**
 * Hyperliquid on-chain adapter (spec §7 #31, docs/hyperliquid-spike.md).
 *
 * HARD RULE (spec §2.2 #31): NO headless scraping — public endpoints only.
 * This adapter never touches session.page(); plain fetch() under
 * session.paced() keeps the rate budget + circuit accounting without ever
 * launching a browser (PlaywrightFetchSession is lazy).
 *
 * Surfaces:
 *   Tier A  GET  stats-data.hyperliquid.xyz/Mainnet/leaderboard — ONE ~32 MB
 *           S3 object covering BOTH native TFs (week→7, month→30); memoized
 *           per session so the 7d and 30d crawls share a single download.
 *           The file is unsorted → sort by window PnL desc (site default,
 *           meta.derived_board_sort), truncate to meta.board_depth (spike §6:
 *           38.6k×2TF×4/day uncapped ≈ 309k entries/day — board capped at
 *           top 10k; the long tail stays reachable via Tier-C by address).
 *   Tier B/C POST api.hyperliquid.xyz/info {portfolio} + {clearinghouseState}
 *           (weights 20 + 2 of 1200/min — rate_budget_ms=1100). One portfolio
 *           response serves all three TFs (90d derived by lerp, spike §3),
 *           so the pair is memoized per (session, trader).
 *   Tier D  POST {clearinghouseState} → open positions, fresh each call.
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
import {
  parseHyperliquidHistory,
  parseHyperliquidLeaderboardPage,
  parseHyperliquidPositions,
  parseHyperliquidProfile,
  TF_WINDOW,
} from './parsers'

const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'
const INFO_URL = 'https://api.hyperliquid.xyz/info'

const DEFAULT_BOARD_DEPTH = 10_000
const DEFAULT_CHUNK_SIZE = 5_000

type Dict = Record<string, unknown>

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** Paced plain-HTTP JSON request — 403/429/401 feed the gate's backoff. */
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
          ? { 'Content-Type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    if (isBlockedStatus(res.status)) throw new BlockedUpstreamError(res.status, url)
    if (!res.ok) throw new Error(`[hyperliquid] HTTP ${res.status} from ${url}`)
    return res.json()
  })
}

// ── Board download, memoized per session (one 32 MB GET serves both TFs) ──

interface BoardFetch {
  rows: Dict[]
  fetchedAt: string
  url: string
}

const boardCache = new WeakMap<FetchSession, Promise<BoardFetch>>()

function getBoard(session: FetchSession, src: SourceRow): Promise<BoardFetch> {
  let cached = boardCache.get(session)
  if (!cached) {
    const url = endpoint(src, 'leaderboard', LEADERBOARD_URL)
    cached = fetchJson(session, url).then((payload) => {
      const rows = (payload as { leaderboardRows?: unknown })?.leaderboardRows
      if (!Array.isArray(rows)) {
        throw new Error(`[hyperliquid] unexpected leaderboard shape from ${url}`)
      }
      return { rows: rows as Dict[], fetchedAt: new Date().toISOString(), url }
    })
    boardCache.set(session, cached)
    cached.catch(() => boardCache.delete(session)) // never memoize a failure
  }
  return cached
}

/** window pnl for the fetch-side sort (mirrors parsers.windowPerf). */
function windowPnlRoi(row: Dict, windowKey: string): { pnl: number; roi: number } {
  const wp = row.windowPerformances
  let perf: Dict | undefined
  if (Array.isArray(wp)) {
    const hit = wp.find((pair) => Array.isArray(pair) && pair[0] === windowKey)
    perf = hit ? (hit as [string, Dict])[1] : undefined
  } else if (wp && typeof wp === 'object') {
    perf = (wp as Record<string, Dict>)[windowKey]
  }
  const pnl = Number(perf?.pnl)
  const roi = Number(perf?.roi)
  return { pnl: Number.isFinite(pnl) ? pnl : 0, roi: Number.isFinite(roi) ? roi : 0 }
}

/** Effective board depth: meta.board_depth (production knob, default 10k),
 *  further capped by meta.max_rows (smoke-run knob). */
function effectiveDepth(src: SourceRow): number {
  const boardDepth = Number(src.meta.board_depth) || DEFAULT_BOARD_DEPTH
  const maxRows = Number(src.meta.max_rows) || null
  return maxRows !== null ? Math.min(boardDepth, maxRows) : boardDepth
}

// ── Profile pair (portfolio + clearinghouseState), memoized per trader ──

interface ProfilePair {
  portfolio: unknown
  clearinghouse: unknown
  /** userFillsByTime over the last 90d (M3-3a fills replay). Null on fetch
   *  failure — the parser NULL-collapses the fills-derived stats. */
  fills: unknown
}

const FILLS_WINDOW_MS = 90 * 86_400_000

const profileCache = new WeakMap<FetchSession, Map<string, Promise<ProfilePair>>>()

function getProfilePair(
  session: FetchSession,
  src: SourceRow,
  address: string
): Promise<ProfilePair> {
  let perSession = profileCache.get(session)
  if (!perSession) {
    perSession = new Map()
    profileCache.set(session, perSession)
  }
  let cached = perSession.get(address)
  if (!cached) {
    const url = endpoint(src, 'info', INFO_URL)
    cached = (async () => {
      const portfolio = await fetchJson(session, url, {
        method: 'POST',
        body: { type: 'portfolio', user: address },
      })
      const clearinghouse = await fetchJson(session, url, {
        method: 'POST',
        body: { type: 'clearinghouseState', user: address },
      })
      // Fills replay (M3-3a): ONE 90d fetch per trader per session — the parser
      // slices per-TF windows from it. userFillsByTime caps at ~2000 fills; for
      // hyperactive accounts that truncates the tail (disclosed via count).
      // Failure never blocks the profile (winRate etc. just stay null).
      const fills = await fetchJson(session, url, {
        method: 'POST',
        body: {
          type: 'userFillsByTime',
          user: address,
          startTime: Date.now() - FILLS_WINDOW_MS,
        },
      }).catch(() => null)
      return { portfolio, clearinghouse, fills }
    })()
    perSession.set(address, cached)
    cached.catch(() => perSession!.delete(address))
  }
  return cached
}

const hyperliquidAdapter: SourceAdapter = {
  slug: 'hyperliquid',
  capabilities: {
    profile: true, // portfolio + clearinghouseState + 90d fills
    positions: true, // clearinghouseState.assetPositions
    // M3-3a: closed positions rebuilt from userFillsByTime round-trips
    // (lib/ingest/adapters/hyperliquid/fills.ts) — the spike-§8.3 replay, now in.
    positionHistory: true,
    orders: false,
    transfers: false,
    copiers: false, // DEX — no copy trading
  },

  /**
   * One S3 download (memoized across both TFs in this session) → sort by
   * the TF's window PnL desc (deterministic tie-breaks) → truncate to the
   * depth knob → chunk into page_size pages. Chunk-local ranks are
   * re-anchored by the Tier-A processor via (pageIndex−1)×page_size, so
   * chunk size MUST equal sources.page_size.
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const board = await getBoard(session, src)
    const windowKey = TF_WINDOW[timeframe]

    const sorted = [...board.rows].sort((a, b) => {
      const pa = windowPnlRoi(a, windowKey)
      const pb = windowPnlRoi(b, windowKey)
      if (pb.pnl !== pa.pnl) return pb.pnl - pa.pnl
      if (pb.roi !== pa.roi) return pb.roi - pa.roi
      return String(a.ethAddress ?? '').localeCompare(String(b.ethAddress ?? ''))
    })
    const truncated = sorted.slice(0, effectiveDepth(src))

    const chunkSize = src.page_size ?? DEFAULT_CHUNK_SIZE
    for (let i = 0; i < truncated.length; i += chunkSize) {
      yield {
        pageIndex: Math.floor(i / chunkSize) + 1,
        payload: {
          timeframe,
          reportedTotal: board.rows.length, // pre-truncation file count
          rows: truncated.slice(i, i + chunkSize),
        },
        url: board.url,
        fetchedAt: board.fetchedAt,
      }
    }
  },

  /**
   * Profile bundle: 2 info POSTs, memoized per (session, trader) so the
   * Tier-B loop over 7/30/90 costs ONE pair per trader. The composite
   * payload embeds the timeframe so parseProfile stays pure (spec §5.5).
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const address = exchangeTraderId.toLowerCase()
    const pair = await getProfilePair(session, src, address)
    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { ...pair, timeframe: timeframe === 0 ? 90 : timeframe },
          url: endpoint(src, 'info', INFO_URL),
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  /** Tier D: always a FRESH clearinghouseState (positions must not reuse a
   *  profile-pair snapshot from earlier in the session). */
  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    const url = endpoint(src, 'info', INFO_URL)
    const payload = await fetchJson(session, url, {
      method: 'POST',
      body: { type: 'clearinghouseState', user: exchangeTraderId.toLowerCase() },
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history') {
      throw new Error(`[hyperliquid] history surface ${kind} not supported`)
    }
    // Reuses the memoized profile pair — position_history costs ZERO extra
    // requests when the Tier-B profile crawl already ran this session.
    const address = exchangeTraderId.toLowerCase()
    const pair = await getProfilePair(session, src, address)
    yield {
      pageIndex: 1,
      payload: { fills: pair.fills },
      url: endpoint(src, 'info', INFO_URL),
      fetchedAt: new Date().toISOString(),
    }
  },

  parseLeaderboard: parseHyperliquidLeaderboardPage,
  parseProfile: parseHyperliquidProfile,
  parsePositions: parseHyperliquidPositions,
  parseHistory: parseHyperliquidHistory,
}

registerAdapter(hyperliquidAdapter)

export { hyperliquidAdapter }
