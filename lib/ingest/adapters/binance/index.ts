/**
 * Binance copy-trading adapter (spec §7 #1/#2, §11.1). ONE adapter serves
 * binance_futures + binance_spot via src.meta.boardKey (like bitget) — the
 * two boards are separate endpoint families with near-identical envelopes:
 *
 *   futures: /bapi/futures/v1/.../future/copy-trade/...
 *   spot:    /bapi/futures/v1/.../future/spot-copy-trade/...
 *
 * Binance is us_blocked (spec §4): sources rows pin fetch_region='vps_sg'
 * and openSession() routes everything through the SG remote browser. The
 * bapi endpoints accept same-origin in-page fetches after one warm page
 * load (external replay was not validated — pageFetcher is the proven
 * path, verified 2026-06-11), so all calls go through pageFetcher.
 *
 * Leaderboard quirk (spec §7): the default Recommend view hides most
 * traders. The list endpoint equivalent of clicking "All Portfolios" +
 * unchecking Smart Filter is `useAiRecommended: false` + portfolioType
 * 'ALL' — total jumps 395 → ~9.8k (futures). No UI clicking needed.
 *
 * Identity: leadPortfolioId (profile URL is
 * /en/copy-trading/lead-details/{leadPortfolioId} — verified live).
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
import type { FetchSession, ReplayRequestTemplate } from '../../fetch/types'
import {
  captureNumericLeaderboard,
  pageFetcher,
  replayJson,
  replayPaged,
  type LeaderboardPublicRequestProjectionInput,
  type NumericLeaderboardPageMeta,
} from '../../fetch/capture'
import {
  parseBinanceHistory,
  parseBinanceLeaderboardPage,
  parseBinancePositions,
  parseBinanceProfile,
} from './parsers'

const BAPI = 'https://www.binance.com/bapi/futures/v1'
const FUT = `${BAPI}/friendly/future/copy-trade`
const FUT_PUB = `${BAPI}/public/future/copy-trade`
const SPOT = `${BAPI}/friendly/future/spot-copy-trade`
const SPOT_PUB = `${BAPI}/public/future/spot-copy-trade`

/** Per-board endpoint families (verified by live capture 2026-06-11). */
const ENDPOINTS: Record<string, Record<string, string>> = {
  futures: {
    list: `${FUT}/home-page/query-list`,
    detail: `${FUT}/lead-portfolio/detail`,
    performance: `${FUT_PUB}/lead-portfolio/performance`,
    chart: `${FUT_PUB}/lead-portfolio/chart-data`,
    coinPreference: `${FUT_PUB}/lead-portfolio/performance/coin`,
    positions: `${FUT}/lead-data/positions`,
    positionHistory: `${FUT}/lead-portfolio/position-history`,
    orders: `${FUT}/lead-portfolio/order-history`,
    transfers: `${FUT}/lead-portfolio/transfer-history`,
    copiers: `${FUT}/lead-portfolio/copy-traders`,
  },
  spot: {
    list: `${SPOT}/common/home-page-list`,
    detail: `${SPOT}/lead-portfolio/detail`,
    performance: `${SPOT_PUB}/lead-portfolio/performance`,
    chart: `${SPOT_PUB}/lead-portfolio/performance-chart-data`,
    coinPreference: `${SPOT}/lead-portfolio/coin-preference`,
    positions: `${SPOT}/lead-portfolio/get-active-holding-by-page`,
    orders: `${SPOT}/lead-portfolio/get-trade-history-by-page`,
    copiers: `${SPOT}/lead-portfolio/get-copy-trader-result-by-page`,
  },
}

const HEADERS = { 'content-type': 'application/json' }

function boardKeyOf(src: SourceRow): string {
  return (src.meta.boardKey as string) ?? 'futures'
}

/** Endpoint lookup: src.meta.endpoints override → board family default. */
function endpoint(src: SourceRow, key: string): string {
  const overrides = (src.meta.endpoints ?? {}) as Record<string, string>
  const family = ENDPOINTS[boardKeyOf(src)] ?? ENDPOINTS.futures
  const url = overrides[key] ?? family[key]
  if (!url) throw new Error(`[binance] no "${key}" endpoint for board ${boardKeyOf(src)}`)
  return url
}

/** Canonical TF → Binance timeRange param (site offers 5; we take 3). */
function timeRangeOf(tf: RankingTimeframe): string {
  return `${tf}D`
}

/**
 * One warm page load establishes session cookies; everything after is
 * same-origin JSON replay (spec §2.2). The remote SG context is created
 * per session, so warm exactly once per FetchSession and keep page loads
 * minimal (bitget warmSession pattern).
 */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.binance.com/en/copy-trading'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  // Park on a near-empty same-origin document: the copy-trading SPA keeps
  // websockets/charts/timers running, and holding it open for a multi-TF
  // crawl crashed the remote SG chromium mid-session ("Browser closed",
  // 2026-06-11). pageFetch only needs the binance.com origin + cookies —
  // robots.txt provides both at ~zero render cost (query-list POST and
  // performance GET both verified 000000 from this page).
  await page.goto('https://www.binance.com/robots.txt', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })
  warmedSessions.add(session)
}

/** Session-scoped detail cache — detail is TF-independent and Tier-B asks
 *  for the 3 TFs back to back (bitget cachedDetailV2 pattern). */
const detailCache = new WeakMap<FetchSession, Map<string, unknown>>()

async function cachedDetail(
  session: FetchSession,
  key: string,
  fetch: () => Promise<unknown>
): Promise<unknown> {
  let cache = detailCache.get(session)
  if (!cache) {
    cache = new Map()
    detailCache.set(session, cache)
  }
  if (cache.has(key)) return cache.get(key)
  const value = await fetch()
  // Bound memory on long sessions: keep only the most recent traders.
  if (cache.size > 50) cache.clear()
  cache.set(key, value)
  return value
}

/** Shared leaderboard body — `useAiRecommended:false` + portfolioType ALL
 *  = the "All Portfolios" tab without the Smart Filter (full population). */
function listBody(pageIndex: number, pageSize: number, timeframe: RankingTimeframe) {
  return {
    pageNumber: pageIndex,
    pageSize,
    timeRange: timeRangeOf(timeframe),
    dataType: 'ROI',
    favoriteOnly: false,
    hideFull: false,
    nickname: '',
    order: 'DESC',
    userAsset: 0,
    portfolioType: 'ALL',
    useAiRecommended: false,
  }
}

const PUBLIC_LIST_BODY_FIELDS = [
  'pageNumber',
  'pageSize',
  'timeRange',
  'dataType',
  'favoriteOnly',
  'hideFull',
  'nickname',
  'order',
  'userAsset',
  'portfolioType',
  'useAiRecommended',
] as const

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function configuredCallerPageCap(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (
    typeof numeric !== 'number' ||
    !Number.isSafeInteger(numeric) ||
    Object.is(numeric, -0) ||
    numeric < 1
  ) {
    throw new TypeError('[binance] meta.max_pages must be a positive safe integer')
  }
  return numeric
}

function binanceLeaderboardMeta(payload: unknown): NumericLeaderboardPageMeta {
  const envelope = recordOf(payload)
  if (envelope?.code !== '000000' || envelope.success !== true) {
    throw new TypeError('[binance] leaderboard response must declare code 000000 and success=true')
  }
  const data = recordOf(envelope.data)
  if (!data || !Array.isArray(data.list)) {
    throw new TypeError('[binance] leaderboard response must contain data.list')
  }
  const total = data.total
  if (total !== null && total !== undefined && typeof total !== 'number') {
    throw new TypeError('[binance] leaderboard data.total must be numeric when reported')
  }
  return {
    // Deliberately count the source collection before parser ID validation.
    rowCount: data.list.length,
    reportedPopulation: total ?? null,
    reportedPageCount: null,
    reportedCurrentPage: null,
    reportedPageSize: null,
  }
}

/** Explicit allowlist: credentials and adapter-only fields never enter RAW provenance. */
export function projectBinanceLeaderboardRequest(
  request: ReplayRequestTemplate
): LeaderboardPublicRequestProjectionInput {
  if (request.method !== 'POST') {
    throw new TypeError('[binance] leaderboard request must be POST')
  }
  const publicUrl = new URL(request.url)
  if ([...publicUrl.searchParams].length > 0) {
    throw new TypeError('[binance] leaderboard list endpoint must not contain query parameters')
  }
  const body = recordOf(request.body)
  if (!body) throw new TypeError('[binance] leaderboard request body must be an object')
  const unknownFields = Object.keys(body).filter(
    (field) => !PUBLIC_LIST_BODY_FIELDS.includes(field as (typeof PUBLIC_LIST_BODY_FIELDS)[number])
  )
  if (unknownFields.length > 0) {
    throw new TypeError(
      `[binance] leaderboard request contains non-public fields: ${unknownFields.join(', ')}`
    )
  }

  const publicBody: Record<string, unknown> = {}
  for (const field of PUBLIC_LIST_BODY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      throw new TypeError(`[binance] leaderboard request is missing public field ${field}`)
    }
    publicBody[field] = body[field]
  }
  publicUrl.hash = ''
  return { method: 'POST', url: publicUrl.href, body: publicBody }
}

const binanceAdapter: SourceAdapter = {
  slug: 'binance',
  capabilities: {
    profile: true,
    positions: true, // futures lead-data/positions; spot active holdings
    positionHistory: true, // futures only (dual sort OPENING+CLOSING)
    orders: true, // futures Latest Records; spot trade history (fills)
    transfers: true, // futures only
    copiers: true, // both boards (PII rules apply downstream)
  },

  async captureLeaderboard(session: FetchSession, src: SourceRow, timeframe: RankingTimeframe) {
    const listUrl = endpoint(src, 'list')
    const pageSize = src.page_size ?? 20
    const callerPageCap = configuredCallerPageCap(src.meta.max_pages)
    await warmSession(session, src)

    return captureNumericLeaderboard({
      session,
      fetcher: pageFetcher(session),
      buildRequest: (pageIndex) => ({
        url: listUrl,
        method: 'POST',
        headers: HEADERS,
        body: listBody(pageIndex, pageSize, timeframe),
      }),
      projectPublicRequest: projectBinanceLeaderboardRequest,
      pageBinding: { location: 'body', path: ['pageNumber'] },
      extractMeta: binanceLeaderboardMeta,
      pageSize,
      callerPageCap,
    })
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list')
    const pageSize = src.page_size ?? 20
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    // Early generator return — replayPaged never sees a truncation, so its
    // completeness assertion stays scoped to real crawls.
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: listUrl,
        method: 'POST',
        headers: HEADERS,
        body: listBody(pageIndex, pageSize, timeframe),
      }),
      extractMeta: (payload) => {
        const parsed = parseBinanceLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield page
      if (maxPages !== null && ++pagesYielded >= maxPages) return
    }
  },

  /**
   * Profile bundle per TF (spec §11.1): detail (TF-independent, cached per
   * session+trader) + performance + ROI/PNL chart series + Asset
   * Preferences donut. parseBinanceProfile consumes the wrapper verbatim.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const timeRange = timeRangeOf(tf)
    const pid = encodeURIComponent(exchangeTraderId)

    const detail = await cachedDetail(session, exchangeTraderId, () =>
      replayJson(session, fetcher, {
        url: `${endpoint(src, 'detail')}?portfolioId=${pid}`,
        method: 'GET',
        headers: HEADERS,
      })
    )
    const performance = await replayJson(session, fetcher, {
      url: `${endpoint(src, 'performance')}?portfolioId=${pid}&timeRange=${timeRange}`,
      method: 'GET',
      headers: HEADERS,
    })
    const chartRoi = await replayJson(session, fetcher, {
      url: `${endpoint(src, 'chart')}?dataType=ROI&portfolioId=${pid}&timeRange=${timeRange}`,
      method: 'GET',
      headers: HEADERS,
    })
    const chartPnl = await replayJson(session, fetcher, {
      url: `${endpoint(src, 'chart')}?dataType=PNL&portfolioId=${pid}&timeRange=${timeRange}`,
      method: 'GET',
      headers: HEADERS,
    })
    const coinPreference = await replayJson(session, fetcher, {
      url: `${endpoint(src, 'coinPreference')}?portfolioId=${pid}&timeRange=${timeRange}`,
      method: 'GET',
      headers: HEADERS,
    })

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detail, performance, chartRoi, chartPnl, coinPreference, timeframe: tf },
          url: endpoint(src, 'performance'),
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
    const url = endpoint(src, 'positions')
    const payload =
      boardKeyOf(src) === 'spot'
        ? // spot: paginated holdings — one 100-row page covers real books
          // (the live max seen is ~dozens of assets)
          await replayJson(session, fetcher, {
            url,
            method: 'POST',
            headers: HEADERS,
            body: {
              pageNumber: 1,
              pageSize: 100,
              portfolioId: exchangeTraderId,
              hideSmallAsset: false,
              hideOfflineAsset: false,
            },
          })
        : // futures: positionRisk-style array over EVERY symbol (zero rows
          // are placeholders — the parser filters them)
          await replayJson(session, fetcher, {
            url: `${url}?portfolioId=${encodeURIComponent(exchangeTraderId)}`,
            method: 'GET',
            headers: HEADERS,
          })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Incremental history pages, newest→oldest (spec §2.3). RAW pages are
   * wrapped { portfolioId, sort, response } so dedupe hashes can include
   * the portfolio id (see parsers.ts).
   *
   * Board coverage differs: spot exposes only orders (fills) + copiers —
   * unsupported kinds yield nothing so Tier-B skips them silently.
   *
   *   position_history (futures): sort=CLOSING is monotonic in closeTime →
   *     cursor-stop works; on FIRST sight (cursor null) the OPENING sort is
   *     also crawled (spec §11.1 dual-sort) and dedupe collapses overlap.
   *   orders (futures): requires a real startTime/endTime window (-1 is
   *     rejected on external construction — verified); window = cursor (or
   *     meta.orders_backfill_days, default 90) → now.
   *   copiers: snapshot table, always crawled in full up to
   *     meta.copier_max_pages (default 10 → 500 copiers at 50/page).
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    const board = boardKeyOf(src)
    const supported =
      board === 'spot'
        ? kind === 'orders' || kind === 'copiers'
        : kind === 'position_history' ||
          kind === 'orders' ||
          kind === 'transfers' ||
          kind === 'copiers'
    if (!supported) return

    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const maxPages = Number(src.meta.history_max_pages ?? 25) || 25
    const cursorMs = cursor ? Date.parse(cursor) : NaN

    const fetchPage = async (url: string, body: Record<string, unknown>): Promise<unknown> =>
      replayJson(session, fetcher, { url, method: 'POST', headers: HEADERS, body })

    /** Page through one POST list endpoint newest→oldest; stop on cursor
     *  overlap via tsOf, short page, or page budget. */
    async function* paged(
      url: string,
      bodyOf: (pageNo: number) => Record<string, unknown>,
      opts: {
        sort?: string
        pageSize: number
        pages: number
        tsOf?: (row: Record<string, unknown>) => number | null
      }
    ): AsyncIterable<RawPage> {
      for (let pageNo = 1; pageNo <= opts.pages; pageNo++) {
        const response = await fetchPage(url, bodyOf(pageNo))
        const data = ((response as Record<string, unknown>)?.data ?? {}) as Record<string, unknown>
        const rows = Array.isArray(data.list) ? (data.list as Array<Record<string, unknown>>) : []
        if (rows.length === 0) break

        yield {
          pageIndex: pageNo,
          payload: { portfolioId: exchangeTraderId, sort: opts.sort ?? null, response },
          url,
          fetchedAt: new Date().toISOString(),
        }

        if (rows.length < opts.pageSize) break
        if (opts.tsOf && Number.isFinite(cursorMs)) {
          const ts = rows.map(opts.tsOf).filter((t): t is number => Number.isFinite(t as number))
          // Overlap reached: this page already dips into stored history.
          if (ts.length > 0 && Math.min(...ts) <= cursorMs) break
        }
      }
    }

    if (kind === 'position_history') {
      const url = endpoint(src, 'positionHistory')
      const tsOf = (r: Record<string, unknown>) =>
        Number.isFinite(Number(r.closed)) ? Number(r.closed) : null
      yield* paged(
        url,
        (pageNo) => ({
          pageNumber: pageNo,
          pageSize: 50,
          portfolioId: exchangeTraderId,
          sort: 'CLOSING',
        }),
        {
          sort: 'CLOSING',
          pageSize: 50,
          pages: maxPages,
          tsOf,
        }
      )
      if (cursor === null) {
        // First-sight backfill: the OPENING view can surface long-lived
        // positions the CLOSING page budget missed (dedupe collapses dupes).
        yield* paged(
          url,
          (pageNo) => ({
            pageNumber: pageNo,
            pageSize: 50,
            portfolioId: exchangeTraderId,
            sort: 'OPENING',
          }),
          {
            sort: 'OPENING',
            pageSize: 50,
            pages: maxPages,
          }
        )
      }
      return
    }

    if (kind === 'orders') {
      if (board === 'spot') {
        yield* paged(
          endpoint(src, 'orders'),
          (pageNo) => ({ pageNumber: pageNo, pageSize: 50, portfolioId: exchangeTraderId }),
          {
            pageSize: 50,
            pages: maxPages,
            tsOf: (r) => (Number.isFinite(Number(r.time)) ? Number(r.time) : null),
          }
        )
        return
      }
      const backfillDays = Number(src.meta.orders_backfill_days ?? 90) || 90
      const endTime = Date.now()
      const startTime = Number.isFinite(cursorMs) ? cursorMs : endTime - backfillDays * 86_400_000
      yield* paged(
        endpoint(src, 'orders'),
        (pageNo) => ({
          pageNumber: pageNo,
          pageSize: 50,
          portfolioId: exchangeTraderId,
          startTime,
          endTime,
        }),
        {
          pageSize: 50,
          pages: maxPages,
          tsOf: (r) => (Number.isFinite(Number(r.orderTime)) ? Number(r.orderTime) : null),
        }
      )
      return
    }

    if (kind === 'transfers') {
      yield* paged(
        endpoint(src, 'transfers'),
        (pageNo) => ({ pageNumber: pageNo, pageSize: 50, portfolioId: exchangeTraderId }),
        {
          pageSize: 50,
          pages: maxPages,
          tsOf: (r) => (Number.isFinite(Number(r.time)) ? Number(r.time) : null),
        }
      )
      return
    }

    // copiers: live snapshot, no cursor — full crawl, page budget capped
    const copierPages = Number(src.meta.copier_max_pages ?? 10) || 10
    yield* paged(
      endpoint(src, 'copiers'),
      (pageNo) => ({ pageNumber: pageNo, pageSize: 50, portfolioId: exchangeTraderId }),
      { pageSize: 50, pages: copierPages }
    )
  },

  parseLeaderboard: parseBinanceLeaderboardPage,
  parseProfile: parseBinanceProfile,
  parsePositions: parseBinancePositions,
  parseHistory: parseBinanceHistory,
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

registerAdapter(binanceAdapter)

export { binanceAdapter }
