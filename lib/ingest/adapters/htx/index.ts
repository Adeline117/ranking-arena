/**
 * HTX Spot & Futures copy-trading adapter (spec §7 #13/#14 / §11.9).
 * ONE adapter serves both arena.sources rows via src.meta.boardKey
 * ('futures' | 'spot') — endpoint paths and payload shapes are identical.
 *
 * Board URLs: futures.htx.com/en-us/copytrading/{futures|spot}
 * Profile URL: /en-us/copytrading/{board}/trader/{userSign}
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source via
 * src.meta.endpoints), base futures.htx.com/-/x/hbg/v1/{board}/copytrading:
 *   list:      GET rank?rankType=1&pageNo=N&pageSize≤50  (totalNum reported;
 *              rankType 1 = PnL(%) sort = FULL population; the "All Traders"
 *              default chip rankType=0 is a curated subset)
 *   profile:   GET trader-info/{trader-base-info, trader-performance,
 *                trader-profit-rate-chart?period, trader-profit-chart?period}
 *              period: 0=24h 1=7d 2=30d 3=90d (boards are 90d-only)
 *   positions: GET trader-info/current-positions?userSign=
 *   history:   GET trader-info/history-positions?userSign&pageNo&pageSize
 *   copiers:   NOT public (login-gated) — capability off, gap noted.
 *
 * All trader-info endpoints are keyed by userSign (rides in traders.meta
 * .user_sign via traderMeta), NOT by uid. Site data refreshes every 15min
 * (spec §11.9 note).
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
  parseHtxHistory,
  parseHtxLeaderboardPage,
  parseHtxPositions,
  parseHtxProfile,
} from './parsers'

const PERIOD: Record<RankingTimeframe, number> = { 7: 1, 30: 2, 90: 3 }

const HEADERS = { accept: 'application/json' }

function boardKey(src: SourceRow): string {
  return typeof src.meta.boardKey === 'string' ? src.meta.boardKey : 'futures'
}

function apiBase(src: SourceRow): string {
  return `https://futures.htx.com/-/x/hbg/v1/${boardKey(src)}/copytrading`
}

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** All trader-info endpoints are keyed by userSign; fall back to the raw id
 *  if a caller has no traders.meta (degrades per adapter contract). */
function userSign(exchangeTraderId: string, traderMeta?: Record<string, unknown> | null): string {
  const sign = traderMeta?.user_sign
  return typeof sign === 'string' && sign.length > 0 ? sign : exchangeTraderId
}

const warmedSessions = new WeakSet<FetchSession>()

/** One page load establishes cookies; everything after is same-origin JSON
 *  replay (spec §2.2). Bundled Chromium headless accepted (verified). */
async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? `https://futures.htx.com/en-us/copytrading/${boardKey(src)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

const htxAdapter: SourceAdapter = {
  slug: 'htx',
  capabilities: {
    profile: true,
    positions: true, // GET trader-info/current-positions
    positionHistory: true, // GET trader-info/history-positions
    orders: false, // no public order-level surface
    transfers: false, // no public balance-history surface
    copiers: false, // followers tab is login-gated (verified 2026-06-11)
  },

  /** Boards are 90d-only (timeframes_native={90}); the timeframe argument
   *  only labels the snapshot — the rank endpoint has no TF param. */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    _timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list', `${apiBase(src)}/rank`)
    const pageSize = src.page_size ?? 50 // server cap: 50 (100 → HTTP 500)
    const rankType = Number(src.meta.list_rank_type) || 1
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: `${listUrl}?rankType=${rankType}&pageNo=${pageIndex}&pageSize=${pageSize}`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseHtxLeaderboardPage(payload, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield page
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) return
    }
  },

  /**
   * Profile bundle (4 replayed GETs): identity + all-time Overview block +
   * PnL(%) chart + daily PnL bars for the requested TF (spec §11.9).
   */
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
    const period = PERIOD[tf]
    const sign = encodeURIComponent(userSign(exchangeTraderId, traderMeta))
    const base = `${apiBase(src)}/trader-info`
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })

    const baseInfo = await get(
      `${endpoint(src, 'baseInfo', `${base}/trader-base-info`)}?userSign=${sign}`
    )
    const performance = await get(
      `${endpoint(src, 'performance', `${base}/trader-performance`)}?userSign=${sign}`
    )
    const profitRateChart = await get(
      `${endpoint(src, 'profitRateChart', `${base}/trader-profit-rate-chart`)}?userSign=${sign}&period=${period}`
    )
    const profitChart = await get(
      `${endpoint(src, 'profitChart', `${base}/trader-profit-chart`)}?userSign=${sign}&period=${period}`
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { baseInfo, performance, profitRateChart, profitChart, timeframe: tf },
          url: `${base}/trader-performance`,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    traderMeta?: Record<string, unknown> | null
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const url = endpoint(src, 'positions', `${apiBase(src)}/trader-info/current-positions`)
    const payload = await replayJson(session, pageFetcher(session), {
      url: `${url}?userSign=${encodeURIComponent(userSign(exchangeTraderId, traderMeta))}`,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * History tab: newest-first numeric pages; stop on empty/short page, on
   * cursor overlap (oldest offsetTime ≤ cursor — dedupe upserts make the
   * overlap page idempotent), or at the safety cap.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null,
    traderMeta?: Record<string, unknown> | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history') {
      throw new Error(`[htx] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const ctx = dummyCtx(src)
    const sign = encodeURIComponent(userSign(exchangeTraderId, traderMeta))
    const url = endpoint(src, 'positionHistory', `${apiBase(src)}/trader-info/history-positions`)
    const limit = 10
    const maxPages = Number(src.meta.history_max_pages) || 20

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?userSign=${sign}&pageNo=${pageIndex}&pageSize=${limit}`,
        method: 'GET',
        headers: HEADERS,
      })
      const rows = parseHtxHistory(payload, 'position_history', ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      if (rows.length < limit) return // last (short) page
      if (cursor !== null) {
        const oldest = rows[rows.length - 1]
        if (oldest.kind === 'position_history' && oldest.closedAt && oldest.closedAt <= cursor) {
          return // overlap reached — older pages are already stored
        }
      }
    }
  },

  parseLeaderboard: parseHtxLeaderboardPage,
  parseProfile: parseHtxProfile,
  parsePositions: parseHtxPositions,
  parseHistory: parseHtxHistory,
}

/** Parse-time ctx for in-adapter parsing (counts/stop rules only). */
function dummyCtx(src: SourceRow): ParseCtx {
  return {
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  }
}

registerAdapter(htxAdapter)

export { htxAdapter }
