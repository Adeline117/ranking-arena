/**
 * Bybit MT5 adapter (copyMt5 "Copy Trading TradFi", spec §7 #3 / §11.2).
 * Phase-1 scale test: ~29.5k traders × pageSize 16 ≈ 1,849 pages per TF at
 * the 2.5s rate budget — single session per crawl, DO NOT lower pacing.
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source
 * via src.meta.endpoints):
 *   list:      GET /x-api/fapi/copymt5/public/v1/common/dynamic-provider-list
 *                  ?pageNo&pageSize&dataDuration=DATA_DURATION_{SEVEN|THIRTY|NINETY}_DAY
 *                  &providerTag=&countryCode=        (empty tag = ALL traders)
 *   info:      GET .../pub-provider/info?providerMark=
 *   stats:     GET .../common/provider-income-detail?providerMark=   (all 3 TFs)
 *   chart:     GET .../provider/dynamic-yield-trend?dayCycleType=...&period=PERIOD_DAY
 *   positions: GET .../provider/open-position?providerMark=
 *   history:   GET .../provider/get-history-position?providerMark=&pageSize=10
 *
 * Access notes (2026-06-11):
 *   - External replay (curl / APIRequestContext) → Akamai "Access Denied";
 *     ONLY same-origin in-page fetch (pageFetcher) passes.
 *   - Bundled Playwright Chromium is TLS-fingerprint blocked on page load
 *     (net::ERR_HTTP2_PROTOCOL_ERROR); the real Chrome channel passes
 *     HEADLESS → sources.meta.browser_channel='chrome' (fetcher knob).
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
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson, replayPaged } from '../../fetch/capture'
import {
  parseBybitMt5History,
  parseBybitMt5LeaderboardPage,
  parseBybitMt5Positions,
  parseBybitMt5Profile,
} from './parsers'

const BASE = 'https://www.bybit.com/x-api/fapi/copymt5/public/v1'

const TF_DURATION: Record<RankingTimeframe, string> = {
  7: 'DATA_DURATION_SEVEN_DAY',
  30: 'DATA_DURATION_THIRTY_DAY',
  90: 'DATA_DURATION_NINETY_DAY',
}

const TF_CYCLE: Record<RankingTimeframe, string> = {
  7: 'DAY_CYCLE_TYPE_SEVEN_DAY',
  30: 'DAY_CYCLE_TYPE_THIRTY_DAY',
  90: 'DAY_CYCLE_TYPE_NINETY_DAY',
}

const HEADERS = { accept: 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/**
 * One page load establishes the Akamai session; everything after is pure
 * same-origin JSON replay (spec §2.2). The persistent context keeps cookies
 * across runs, so later sessions usually replay without a fresh page load.
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.bybit.com/copyMt5/'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

/** Session-scoped cache for the TF-independent profile requests (info +
 *  income-detail cover all 3 TFs) — Tier-B fetches 3 TFs back to back and
 *  only the chart varies per TF. */
const profileCache = new WeakMap<FetchSession, Map<string, unknown>>()

async function cached(
  session: FetchSession,
  key: string,
  fetch: () => Promise<unknown>
): Promise<unknown> {
  let cache = profileCache.get(session)
  if (!cache) {
    cache = new Map()
    profileCache.set(session, cache)
  }
  if (cache.has(key)) return cache.get(key)
  const value = await fetch()
  // Bound memory on long sessions: keep only the most recent traders.
  if (cache.size > 100) cache.clear()
  cache.set(key, value)
  return value
}

const bybitMt5Adapter: SourceAdapter = {
  slug: 'bybit_mt5',
  capabilities: {
    profile: true,
    positions: true, // GET provider/open-position
    positionHistory: true, // GET provider/get-history-position (newest 10 only)
    orders: false,
    transfers: false,
    // provider/follower-list is PRIVATE (auth-gated) on MT5 — verified 2026-06-11
    copiers: false,
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/common/dynamic-provider-list`)
    const pageSize = src.page_size ?? 16
    // Validation knob: src.meta.max_pages caps the crawl (e.g. 20 pages for
    // a smoke run). Early generator return — replayPaged never sees a
    // truncation, so its completeness assertion stays scoped to real crawls.
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?pageNo=${pageIndex}&pageSize=${pageSize}` +
          `&dataDuration=${TF_DURATION[timeframe]}&providerTag=&countryCode=`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseBybitMt5LeaderboardPage(payload, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield page
      if (maxPages !== null && ++pagesYielded >= maxPages) return
    }
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const mark = encodeURIComponent(exchangeTraderId)

    // info + income-detail are TF-independent (income-detail carries all
    // 3 TF blocks) — fetched once per (session, trader).
    const infoUrl = endpoint(src, 'info', `${BASE}/pub-provider/info`)
    const info = await cached(session, `info:${exchangeTraderId}`, () =>
      replayJson(session, fetcher, {
        url: `${infoUrl}?providerMark=${mark}`,
        method: 'GET',
        headers: HEADERS,
      })
    )
    const statsUrl = endpoint(src, 'stats', `${BASE}/common/provider-income-detail`)
    const incomeDetail = await cached(session, `stats:${exchangeTraderId}`, () =>
      replayJson(session, fetcher, {
        url: `${statsUrl}?providerMark=${mark}`,
        method: 'GET',
        headers: HEADERS,
      })
    )
    const chartUrl = endpoint(src, 'chart', `${BASE}/provider/dynamic-yield-trend`)
    const yieldTrend = await replayJson(session, fetcher, {
      url: `${chartUrl}?dayCycleType=${TF_CYCLE[tf]}&period=PERIOD_DAY&providerMark=${mark}`,
      method: 'GET',
      headers: HEADERS,
    })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { info, incomeDetail, yieldTrend, timeframe: tf },
          url: chartUrl,
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
    const url = endpoint(src, 'positions', `${BASE}/provider/open-position`)
    const payload = await replayJson(session, fetcher, {
      url: `${url}?providerMark=${encodeURIComponent(exchangeTraderId)}`,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * 平仓仓位 — PUBLIC DEPTH LIMIT (verified 2026-06-11): the endpoint
   * returns only the newest 10 rows regardless of pageSize/limit, and the
   * response `cursor` jumps to the OLDEST segment then loops in place. So
   * each crawl yields exactly one page; coverage accumulates across crawls
   * via the dedupe-hash upserts (spec §2.3 incremental semantics intact).
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    _cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history') {
      throw new Error(`[bybit-mt5] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url = endpoint(src, 'positionHistory', `${BASE}/provider/get-history-position`)
    const payload = await replayJson(session, fetcher, {
      url: `${url}?providerMark=${encodeURIComponent(exchangeTraderId)}&pageSize=10`,
      method: 'GET',
      headers: HEADERS,
    })
    yield { pageIndex: 1, payload, url, fetchedAt: new Date().toISOString() }
  },

  parseLeaderboard: parseBybitMt5LeaderboardPage,
  parseProfile: parseBybitMt5Profile,
  parsePositions: parseBybitMt5Positions,
  parseHistory: parseBybitMt5History,
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

registerAdapter(bybitMt5Adapter)

export { bybitMt5Adapter }
