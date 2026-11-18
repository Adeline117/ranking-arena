/**
 * Hyperliquid on-chain adapter (spec §7 #31, docs/hyperliquid-spike.md).
 *
 * HARD RULE (spec §2.2 #31): NO headless scraping — public endpoints only.
 * This adapter never touches session.page(); plain fetch() under
 * session.paced() keeps the rate budget + circuit accounting without ever
 * launching a browser (PlaywrightFetchSession is lazy).
 *
 * Surfaces:
 *   Tier A  GET  stats-data.hyperliquid.xyz/Mainnet/leaderboard — ONE ~39 MB
 *           S3/CloudFront object (48,027 rows on 2026-11-18) carrying every
 *           window (week→7, month→30, allTime→90 per owner plan A). The
 *           attempt-bound capture stores that document VERBATIM, one capture
 *           per timeframe, and the parser ranks the whole population for the
 *           window (ParseCtx.timeframe). No truncation: Tier-A publication
 *           requires the accepted rows to equal the observed population.
 *           Completeness is exhaustion mode (HYPERLIQUID_LEADERBOARD_EXHAUSTION):
 *           one short page (rows < sources.page_size) ends the board, and the
 *           document is re-read to prove it did not change mid-capture.
 *   Tier B/C POST api.hyperliquid.xyz/info {portfolio} + {clearinghouseState}
 *           (weights 20 + 2 of 1200/min — rate_budget_ms=1100). One portfolio
 *           response serves all three TFs (90D ROI/PnL = board allTime, plan A),
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
import { captureNumericLeaderboard, type JsonFetcher } from '../../fetch/capture'
import { allowlistedPublicRequest, collectionMeta } from '../../fetch/replay-capture'
import type { LeaderboardExhaustionDeclaration } from '../../acquisition-exhaustion'
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

/**
 * Reviewed exhaustion contract (registered in
 * arena.leaderboard_exhaustion_contracts). The board is one document: its
 * single page is short against sources.page_size (a declared ceiling far
 * above the population), and a re-read must return the same row keys.
 */
export const HYPERLIQUID_LEADERBOARD_EXHAUSTION: LeaderboardExhaustionDeclaration = Object.freeze({
  completeness_mode: 'exhausted' as const,
  list_path: ['leaderboardRows'],
  row_key_path: ['ethAddress'],
  end_signal: { kind: 'short_page' as const },
  board_version: { kind: 'first_page_reread' as const },
  max_duplicate_rows: 0,
})

/**
 * The document has no pagination. The numeric capture contract binds every
 * request to a 1-based page in its public request, so the request carries
 * `page=1`, which the endpoint ignores (live 2026-11-18: identical bytes and
 * ETag with and without it). The capture never asks for page 2: a document at
 * or above the page-size ceiling ends at the one-request safety cap and
 * cannot verify.
 */
const BOARD_PAGE_QUERY_KEY = 'page'

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

// ── Board download for the 90D profile block (native allTime), memoized per session ──

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

/**
 * Native allTime window ({pnl, roi}) per address — the basis of the 90D board
 * (owner plan A, TF_WINDOW[90] = 'allTime'). The profile's 90D block carries
 * these exact values so board and profile agree. Built once per session from
 * the memoized board; a failed download is memoized as "unavailable" (logged
 * once) so a Tier-B pass cannot re-download 32 MB per trader.
 */
const boardAllTimeIndex = new WeakMap<FetchSession, Promise<Map<string, Dict> | null>>()

function boardAllTime(
  session: FetchSession,
  src: SourceRow,
  address: string
): Promise<Dict | null> {
  let index = boardAllTimeIndex.get(session)
  if (!index) {
    index = getBoard(session, src).then(
      (board) => {
        const byAddress = new Map<string, Dict>()
        for (const row of board.rows) {
          const id = String(row.ethAddress ?? '').toLowerCase()
          const wp = row.windowPerformances
          const perf = Array.isArray(wp)
            ? (
                wp.find((pair) => Array.isArray(pair) && pair[0] === 'allTime') as
                  | [string, Dict]
                  | undefined
              )?.[1]
            : ((wp as Record<string, Dict> | undefined)?.allTime ?? undefined)
          if (id && perf) byAddress.set(id, perf)
        }
        return byAddress
      },
      (err: unknown) => {
        console.warn(
          `[hyperliquid] board download failed; 90D profile blocks skipped this session:`,
          err instanceof Error ? err.message : err
        )
        return null
      }
    )
    boardAllTimeIndex.set(session, index)
  }
  return index.then((byAddress) => byAddress?.get(address) ?? null)
}

/** Unpaced plain GET for the capture, which paces each request itself. */
function boardFetcher(signal: AbortSignal | undefined): JsonFetcher {
  return async (template) => {
    const response = await fetch(template.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    })
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      // non-JSON body: the capture records it as a failed answer
    }
    return { status: response.status, json }
  }
}

/** The whole document is the board: a missing row array is an upstream error. */
const hyperliquidBoardMeta = collectionMeta({
  label: 'hyperliquid',
  assertSuccess: (payload) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('[hyperliquid] leaderboard response is not a JSON object')
    }
  },
  list: ['leaderboardRows'],
})

/**
 * `page=<n>` is really sent on the wire and is recorded as-is in the request
 * evidence (public projection, request_sha256). The upstream IGNORES it: the
 * CloudFront/S3 object returns the same bytes and ETag for any query string
 * (verified 2026-11-18). It therefore never selects a slice of the board; the
 * whole population is always the single response, and only n=1 is requested
 * (safetyPageCap 1; the exhaustion re-read asks for page 1 again).
 */
function boardRequestUrl(src: SourceRow, pageIndex: number): string {
  const url = new URL(endpoint(src, 'leaderboard', LEADERBOARD_URL))
  url.searchParams.set(BOARD_PAGE_QUERY_KEY, String(pageIndex))
  return url.href
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
   * One verbatim document per timeframe, plus the exhaustion re-read. Never
   * memoized across timeframes: each capture's evidence is its own requests.
   */
  async captureLeaderboard(session, src, timeframe, options) {
    options?.signal?.throwIfAborted()
    if (!Object.prototype.hasOwnProperty.call(TF_WINDOW, timeframe)) {
      throw new Error(`[hyperliquid] no board window for ${timeframe}d`)
    }
    const pageSize = src.page_size
    if (pageSize === null || !Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new Error('[hyperliquid] board capture requires sources.page_size (the row ceiling)')
    }
    if (src.pagination_kind !== 'numeric') {
      throw new Error('[hyperliquid] board capture requires numeric sources.pagination_kind')
    }
    return captureNumericLeaderboard({
      session,
      fetcher: boardFetcher(options?.signal),
      signal: options?.signal,
      buildRequest: (pageIndex) => ({
        url: boardRequestUrl(src, pageIndex),
        method: 'GET',
        headers: {},
      }),
      projectPublicRequest: allowlistedPublicRequest({ query: [BOARD_PAGE_QUERY_KEY] }),
      pageBinding: { location: 'query', key: BOARD_PAGE_QUERY_KEY },
      extractMeta: hyperliquidBoardMeta,
      pageSize,
      safetyPageCap: 1,
      exhaustion: HYPERLIQUID_LEADERBOARD_EXHAUSTION,
    })
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await hyperliquidAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
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
    // Only the scheduled crawl pays for the shared board download; other
    // intents get no 90D stats block (the board's own value stays).
    const nativeAllTimePromise =
      intent === 'scheduled_full' && (timeframe === 90 || timeframe === 0)
        ? boardAllTime(session, src, address)
        : Promise.resolve(null)
    const [base, outcome, boardAllTimePerf] = await Promise.all([
      basePromise,
      outcomePromise,
      nativeAllTimePromise,
    ])
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
            boardAllTime: boardAllTimePerf,
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
        historyTraderIdentity: address,
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
