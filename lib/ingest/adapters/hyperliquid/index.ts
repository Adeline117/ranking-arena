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
import {
  registerAdapter,
  type ProfileFetchOptions,
  type ProfileFetchIntent,
  type SourceAdapter,
} from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { BlockedUpstreamError, isBlockedStatus } from '../../fetch/rate-limiter'
import {
  parseHyperliquidHistory,
  parseHyperliquidLeaderboardPage,
  parseHyperliquidPositions,
  parseHyperliquidProfile,
  TF_WINDOW,
} from './parsers'
import {
  fetchHyperliquidFillsWindow,
  HyperliquidFillsFetchError,
  type HyperliquidFillsFetch,
} from './fills-fetch'

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

// ── Profile base + fills, independently memoized per trader/session ──

interface ProfileBase {
  portfolio: unknown
  clearinghouse: unknown
}

interface FillsOutcome {
  state: 'fetched' | 'failed'
  snapshot: HyperliquidFillsFetch | null
  reason: string | null
}

interface ProfileCacheEntry {
  base?: Promise<ProfileBase>
  fills?: Promise<FillsOutcome>
}

const FILLS_WINDOW_MS = 90 * 86_400_000
const DEFAULT_FILLS_PAGE_GAP_MS = 6_000

function fillsPageGapMs(src: SourceRow): number {
  const configured = Number(src.meta.fills_page_gap_ms)
  return Number.isFinite(configured)
    ? Math.max(DEFAULT_FILLS_PAGE_GAP_MS, Math.trunc(configured))
    : DEFAULT_FILLS_PAGE_GAP_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const profileCache = new WeakMap<FetchSession, Map<string, ProfileCacheEntry>>()

function profileEntry(session: FetchSession, address: string): ProfileCacheEntry {
  let perSession = profileCache.get(session)
  if (!perSession) {
    perSession = new Map()
    profileCache.set(session, perSession)
  }
  let entry = perSession.get(address)
  if (!entry) {
    entry = {}
    perSession.set(address, entry)
  }
  return entry
}

function getProfileBase(
  session: FetchSession,
  src: SourceRow,
  address: string
): Promise<ProfileBase> {
  const entry = profileEntry(session, address)
  if (!entry.base) {
    const url = endpoint(src, 'info', INFO_URL)
    const base = (async () => {
      const portfolio = await fetchJson(session, url, {
        method: 'POST',
        body: { type: 'portfolio', user: address },
      })
      const clearinghouse = await fetchJson(session, url, {
        method: 'POST',
        body: { type: 'clearinghouseState', user: address },
      })
      return { portfolio, clearinghouse }
    })()
    entry.base = base
    base.catch(() => {
      if (entry.base === base) entry.base = undefined
    })
  }
  return entry.base
}

function getFills(session: FetchSession, src: SourceRow, address: string): Promise<FillsOutcome> {
  const entry = profileEntry(session, address)
  if (!entry.fills) {
    const url = endpoint(src, 'info', INFO_URL)
    entry.fills = (async () => {
      const fillsEndTime = Date.now()
      const fillsStartTime = fillsEndTime - FILLS_WINDOW_MS
      try {
        const snapshot = await fetchHyperliquidFillsWindow(
          (startTime, endTime) =>
            fetchJson(session, url, {
              method: 'POST',
              body: {
                type: 'userFillsByTime',
                user: address,
                startTime,
                endTime,
                aggregateByTime: false,
              },
            }),
          fillsStartTime,
          fillsEndTime,
          { beforeNextPage: () => sleep(fillsPageGapMs(src)) }
        )
        return {
          state: 'fetched',
          snapshot,
          reason: snapshot.meta.failureReason,
        }
      } catch (error) {
        if (error instanceof HyperliquidFillsFetchError) {
          return { state: 'failed', snapshot: error.partial, reason: error.reason }
        }
        return { state: 'failed', snapshot: null, reason: 'unexpected_fetch_failure' }
      }
    })()
  }
  return entry.fills
}

const PROFILE_FETCH_INTENTS = new Set<ProfileFetchIntent>([
  'scheduled_full',
  'series_only',
  'interactive_deferred',
])

function requireProfileIntent(options: ProfileFetchOptions | undefined): ProfileFetchIntent {
  const intent = options?.intent
  if (!intent || !PROFILE_FETCH_INTENTS.has(intent)) {
    throw new Error('[hyperliquid] missing or invalid profile fetch intent')
  }
  return intent
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
   * Base profile calls are memoized for every intent. Only scheduled_full
   * starts the weight-heavy fills pagination; series and interactive paths
   * explicitly defer it while retaining independently cached portfolio data.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe,
    _traderMeta: Record<string, unknown> | null | undefined,
    options: ProfileFetchOptions
  ): Promise<RawBundle> {
    const intent = requireProfileIntent(options)
    const address = exchangeTraderId.toLowerCase()
    const basePromise = getProfileBase(session, src, address)
    const outcomePromise =
      intent === 'scheduled_full'
        ? getFills(session, src, address)
        : Promise.resolve({
            state: 'deferred' as const,
            snapshot: null,
            reason: 'deferred_by_profile_intent',
          })
    const [base, outcome] = await Promise.all([basePromise, outcomePromise])
    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            ...base,
            timeframe: timeframe === 0 ? 90 : timeframe,
            profileFetchIntent: intent,
            fillsFetchState: outcome.state,
            fillsFetchReason: outcome.reason,
            fillsSnapshot: outcome.snapshot,
          },
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
    // Reuses a scheduled profile's fill promise, or lazily starts it when the
    // history surface is the first deep request in this session.
    const address = exchangeTraderId.toLowerCase()
    const outcome = await getFills(session, src, address)
    yield {
      pageIndex: 1,
      payload: {
        fillsFetchTrigger: 'history',
        fillsFetchState: outcome.state,
        fillsFetchReason: outcome.reason,
        fillsSnapshot: outcome.snapshot,
      },
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
