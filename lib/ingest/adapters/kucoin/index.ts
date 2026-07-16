/**
 * KuCoin Futures copy-trading adapter ("Copy Trading Hub", spec §7 #28 /
 * §11.17). Board URL: https://www.kucoin.com/copytrading
 * Profile URL: /copytrading/trader-profile/{leadConfigId}
 *
 * Endpoints (verified by live capture 2026-06-11; overridable per-source via
 * src.meta.endpoints), base www.kucoin.com/_api/ct-copy-trade/v1/copyTrading:
 *   list:      POST rn/leaderboard/query (JSON body, pageSize≤100, totalNum)
 *   profile:   GET leadShow/{summary, overview, pnl/history?period={tf}d,
 *                currencyPreference}  (4 replayed GETs per TF)
 *   orders:    GET cross/futures/lead/order?leadConfigId&pageNum&pageSize
 *   copiers:   GET leadShow/copyTraders?leadConfigId&pageNum&pageSize
 *   positions / position-history: NOT public (visibility-gated, data:null).
 *
 * The board is 30d-anchored with NO timeframe param → timeframes_native={30}
 * (the seeded {7,30,90} came from the survey's filter-modal misread — that
 * filter is "Days as Lead", not a TF picker). Per-TF profile depth still
 * exists via pnl/history period=7d/30d/90d.
 *
 * TradePilot badge rows (exchange ≠ 'KU') → trader_kind='bot', strategy
 * 'ai' (spec §11.17).
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
  parseKucoinHistory,
  parseKucoinLeaderboardPage,
  parseKucoinPositions,
  parseKucoinProfile,
  validateKucoinProfile,
} from './parsers'

const BASE = 'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading'

const GET_HEADERS = { accept: 'application/json' }
const POST_HEADERS = { accept: 'application/json', 'content-type': 'application/json' }

const TF_PERIOD: Record<RankingTimeframe, string> = { 7: '7d', 30: '30d', 90: '90d' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

const warmedSessions = new WeakSet<FetchSession>()

/** One page load establishes cookies; everything after is same-origin JSON
 *  replay (spec §2.2). Bundled Chromium headless accepted (verified). */
async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? 'https://www.kucoin.com/copytrading'
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined) // best-effort — a busy page still yields valid cookies
  warmedSessions.add(session)
}

const kucoinAdapter: SourceAdapter = {
  slug: 'kucoin',
  capabilities: {
    profile: true,
    positions: false, // visibility-gated (no public endpoint found)
    positionHistory: false, // leadShow/positionHistory answers data:null
    orders: true, // GET cross/futures/lead/order
    transfers: false, // no public balance-history surface
    copiers: true, // GET leadShow/copyTraders
  },

  /** Board is 30d-anchored; the timeframe argument only labels the snapshot
   *  (timeframes_native={30} — the query has no TF param). */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    _timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/rn/leaderboard/query?lang=en_US`)
    const pageSize = src.page_size ?? 100
    const sortField =
      typeof src.meta.list_sort_field === 'string' ? src.meta.list_sort_field : 'ranking_score'
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: listUrl,
        method: 'POST',
        headers: POST_HEADERS,
        body: {
          criteria: [],
          sort: { field: sortField, direction: 'DESC' },
          hideFull: false,
          currentPage: pageIndex,
          pageSize,
        },
      }),
      extractMeta: (payload) => {
        const parsed = parseKucoinLeaderboardPage(payload, dummyCtx(src))
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
   * Profile bundle per TF (4 replayed GETs): identity + overview block +
   * cumulative PnL chart for the TF window + preferred-assets donut.
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
    const id = encodeURIComponent(exchangeTraderId)
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: GET_HEADERS })

    const summary = await get(
      `${endpoint(src, 'summary', `${BASE}/leadShow/summary`)}?lang=en_US&leadConfigId=${id}`
    )
    const overview = await get(
      `${endpoint(src, 'overview', `${BASE}/leadShow/overview`)}?lang=en_US&leadConfigId=${id}`
    )
    const pnlHistory = await get(
      `${endpoint(src, 'pnlHistory', `${BASE}/leadShow/pnl/history`)}?lang=en_US&leadConfigId=${id}&period=${TF_PERIOD[tf]}`
    )
    const currencyPreference = await get(
      `${endpoint(src, 'currencyPreference', `${BASE}/leadShow/currencyPreference`)}?lang=en_US&leadConfigId=${id}`
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { summary, overview, pnlHistory, currencyPreference, timeframe: tf },
          url: `${BASE}/leadShow/summary`,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(): Promise<RawBundle> {
    throw new Error('[kucoin] current positions are not publicly exposed')
  },

  /**
   * Orders: newest-first numeric pages with reported totalPage; stop on
   * empty/short page, on cursor overlap (oldest tradeTime ≤ cursor), or at
   * the safety cap (order books run deep — totalNum 2000+ for active
   * traders). Copiers: snapshot-style full pagination.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'orders' && kind !== 'copiers') {
      throw new Error(`[kucoin] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const ctx = dummyCtx(src)
    const id = encodeURIComponent(exchangeTraderId)
    const limit = 10

    if (kind === 'orders') {
      const url = endpoint(src, 'orders', `${BASE}/cross/futures/lead/order`)
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url: `${url}?lang=en_US&leadConfigId=${id}&pageNum=${pageIndex}&pageSize=${limit}`,
          method: 'GET',
          headers: GET_HEADERS,
        })
        const rows = parseKucoinHistory(payload, 'orders', ctx)
        if (rows.length === 0) return
        yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
        if (rows.length < limit) return // last (short) page
        if (cursor !== null) {
          const oldest = rows[rows.length - 1]
          if (oldest.kind === 'orders' && oldest.ts <= cursor) {
            return // overlap reached — older pages are already stored
          }
        }
      }
      return
    }

    // copiers
    const url = endpoint(src, 'copiers', `${BASE}/leadShow/copyTraders`)
    const maxPages = Number(src.meta.copier_max_pages) || 30
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?lang=en_US&leadConfigId=${id}&pageNum=${pageIndex}&pageSize=${limit}`,
        method: 'GET',
        headers: GET_HEADERS,
      })
      const rows = parseKucoinHistory(payload, 'copiers', ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      const totalPage = Number((payload as { data?: { totalPage?: unknown } })?.data?.totalPage)
      if (Number.isFinite(totalPage) && totalPage > 0 && pageIndex >= totalPage) return
      if (rows.length < limit) return
    }
  },

  parseLeaderboard: parseKucoinLeaderboardPage,
  parseProfile: parseKucoinProfile,
  validateProfile: validateKucoinProfile,
  parsePositions: parseKucoinPositions,
  parseHistory: parseKucoinHistory,
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

registerAdapter(kucoinAdapter)

export { kucoinAdapter }
