/**
 * CoinEx Futures copy-trading adapter (spec §7 #12 / §11.8 / §11.23).
 * Board URL: https://www.coinex.com/en/copy-trading/traders
 * Profile URL: /en/copy-trading/traders/data/{trader_id}
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source via
 * src.meta.endpoints), base https://www.coinex.com/res/copy-trading/public:
 *   list:      GET traders?data_type=profit_rate&time_range=DAY{7,30,90}
 *                &hide_full=0&page=N&limit≤100   (reported total + has_next)
 *   profile:   GET trader-detail / trade-data / profit-series / aum-series /
 *                market-percent  (5 replayed GETs per TF)
 *   positions: GET current-position?trader_id=
 *   history:   GET finished-position?trader_id&page&limit
 *   copiers:   GET followers?trader_id&page&limit
 *
 * The site shows a geo-notice dialog on US IPs but the public JSON endpoints
 * answer regardless — replay is unaffected (verified 2026-06-11).
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
  parseCoinexHistory,
  parseCoinexLeaderboardPage,
  parseCoinexPositions,
  parseCoinexProfile,
} from './parsers'

const BASE = 'https://www.coinex.com/res/copy-trading/public'

const TF_RANGE: Record<RankingTimeframe, string> = {
  7: 'DAY7',
  30: 'DAY30',
  90: 'DAY90',
}

const HEADERS = { accept: 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** One page load establishes cookies; everything after is same-origin JSON
 *  replay (spec §2.2). Bundled Chromium headless accepted (verified). */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.coinex.com/en/copy-trading/traders'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // networkidle is best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

const coinexAdapter: SourceAdapter = {
  slug: 'coinex',
  capabilities: {
    profile: true,
    positions: true, // GET current-position
    positionHistory: true, // GET finished-position (Lead History)
    orders: false, // no public order-level surface
    transfers: false, // no public balance-history surface
    copiers: true, // GET followers
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/traders`)
    const pageSize = src.page_size ?? 100
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?data_type=profit_rate&time_range=${TF_RANGE[timeframe]}` +
          `&hide_full=0&page=${pageIndex}&limit=${pageSize}`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseCoinexLeaderboardPage(payload, dummyCtx(src))
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
   * Profile bundle per TF (5 replayed GETs): identity + Data Overview +
   * PNL Data chart + AUM chart + Futures Trading Preferences (spec §11.8).
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
    const range = TF_RANGE[tf]
    const tid = encodeURIComponent(exchangeTraderId)
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })

    const traderDetail = await get(
      `${endpoint(src, 'traderDetail', `${BASE}/trader-detail`)}?trader_id=${tid}`
    )
    const tradeData = await get(
      `${endpoint(src, 'tradeData', `${BASE}/trade-data`)}?trader_id=${tid}`
    )
    const profitSeries = await get(
      `${endpoint(src, 'profitSeries', `${BASE}/profit-series`)}?trader_id=${tid}&time_range=${range}`
    )
    const aumSeries = await get(
      `${endpoint(src, 'aumSeries', `${BASE}/aum-series`)}?trader_id=${tid}&time_range=${range}`
    )
    const marketPercent = await get(
      `${endpoint(src, 'marketPercent', `${BASE}/market-percent`)}?trader_id=${tid}&time_range=${range}`
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            traderDetail,
            tradeData,
            profitSeries,
            aumSeries,
            marketPercent,
            timeframe: tf,
          },
          url: `${BASE}/trader-detail`,
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
    const url = endpoint(src, 'positions', `${BASE}/current-position`)
    const payload = await replayJson(session, pageFetcher(session), {
      url: `${url}?trader_id=${encodeURIComponent(exchangeTraderId)}`,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Lead History: newest-first numeric pages; stop on empty/short page, on
   * cursor overlap (oldest update_time ≤ cursor — the processor's dedupe
   * upserts make the overlap page idempotent), or at the safety cap.
   * Followers: snapshot-style full pagination via has_next.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[coinex] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const ctx = dummyCtx(src)
    const tid = encodeURIComponent(exchangeTraderId)
    const limit = 10 // verified server page size for both surfaces

    if (kind === 'position_history') {
      const url = endpoint(src, 'positionHistory', `${BASE}/finished-position`)
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url: `${url}?trader_id=${tid}&page=${pageIndex}&limit=${limit}`,
          method: 'GET',
          headers: HEADERS,
        })
        const rows = parseCoinexHistory(payload, 'position_history', ctx)
        if (rows.length === 0) return
        yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
        const hasNext = Boolean((payload as { data?: { has_next?: unknown } })?.data?.has_next)
        if (!hasNext || rows.length < limit) return
        if (cursor !== null) {
          const oldest = rows[rows.length - 1]
          if (oldest.kind === 'position_history' && oldest.closedAt && oldest.closedAt <= cursor) {
            return // overlap reached — older pages are already stored
          }
        }
      }
      return
    }

    // copiers
    const url = endpoint(src, 'copiers', `${BASE}/followers`)
    const maxPages = Number(src.meta.copier_max_pages) || 30
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?trader_id=${tid}&page=${pageIndex}&limit=${limit}`,
        method: 'GET',
        headers: HEADERS,
      })
      const rows = parseCoinexHistory(payload, 'copiers', ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      const hasNext = Boolean((payload as { data?: { has_next?: unknown } })?.data?.has_next)
      if (!hasNext || rows.length < limit) return
    }
  },

  parseLeaderboard: parseCoinexLeaderboardPage,
  parseProfile: parseCoinexProfile,
  parsePositions: parseCoinexPositions,
  parseHistory: parseCoinexHistory,
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

registerAdapter(coinexAdapter)

export { coinexAdapter }
