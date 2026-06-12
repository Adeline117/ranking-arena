/**
 * LBank Futures copy-trading adapter (spec §7 #37 / §11.22).
 * Board URL: https://www.lbank.com/copy-trading?tab=all
 * Profile URL: /copy-trading/lead-trader/{openId}
 *
 * FETCH MODEL: the API host (uuapi.rerrkvifj.com) rejects in-page
 * cross-origin fetch ({"error_code":10006,"msg":"not open path"}) but
 * accepts APIRequestContext replay carrying the page's own captured request
 * headers (ex-client-type/ex-client-source/source/versionflage — verified
 * 2026-06-11). warmSession captures one live futures-follow-center request
 * during the board page load; every replay merges those headers.
 *
 * Endpoints (base uuapi.rerrkvifj.com/futures-follow-center/trader):
 *   list:      GET stat/v1/getAll?name=&size&current&topFlag=0
 *                &hiddenFullFlag=0&sortField={rankingValue|owRankingValue}
 *                &sortDirection=1
 *              sortField prefix selects the TF window (bare=30d, ow=7d) and
 *              re-computes the s* "selected" fields. NO 90d board; 14D/180D
 *              labels ignored (spec §11.22).
 *   profile:   GET head/info + stat/v1/get?type={1w,1m} +
 *              POST queryProfitRate/queryProfit/queryTradeVolume/
 *                   queryTradePreference {openId, periodType: 7d→2, 30d→4}
 *   positions: GET trade/v1/positions/{openId}
 *   history:   GET stat/v1/position/history?…&startTime&endTime (SECONDS)
 *   copiers:   GET stat/v1/followers?current&size&traderId
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
import { replayJson, replayPaged, type JsonFetcher } from '../../fetch/capture'
import {
  parseLbankHistory,
  parseLbankLeaderboardPage,
  parseLbankPositions,
  parseLbankProfile,
} from './parsers'

const BASE = 'https://uuapi.rerrkvifj.com/futures-follow-center/trader'

/** TF → board sortField (window selector) / stat type / chart periodType. */
const TF_SORT: Record<number, string> = { 7: 'owRankingValue', 30: 'rankingValue' }
const TF_TYPE: Record<number, string> = { 7: '1w', 30: '1m' }
const TF_PERIOD: Record<number, number> = { 7: 2, 30: 4 }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** LBank boards are 7/30 only — clamp anything else to 30. */
function clampTf(timeframe: Timeframe): 7 | 30 {
  return timeframe === 7 ? 7 : 30
}

/** Captured page-request headers per session (see FETCH MODEL above). */
const sessionHeaders = new WeakMap<FetchSession, Record<string, string>>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (sessionHeaders.has(session)) return
  const capture = await session.capture(/futures-follow-center/)
  try {
    const page = await session.page()
    const url = src.leaderboard_url ?? 'https://www.lbank.com/copy-trading?tab=all'
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const exchange = await capture.first(45_000)
    sessionHeaders.set(session, exchange.template.headers)
  } finally {
    capture.dispose()
  }
}

/** APIRequestContext replay carrying the captured page headers. */
function lbankFetcher(session: FetchSession): JsonFetcher {
  return async (template) => {
    const api = await session.api()
    const headers = { ...(sessionHeaders.get(session) ?? {}), ...template.headers }
    const response =
      template.method === 'POST'
        ? await api.post(template.url, {
            headers: { ...headers, 'content-type': 'application/json' },
            data: template.body as Record<string, unknown>,
          })
        : await api.get(template.url, { headers })
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      // non-JSON body — caller decides
    }
    return { status: response.status(), json }
  }
}

const lbankAdapter: SourceAdapter = {
  slug: 'lbank',
  capabilities: {
    profile: true,
    positions: true, // GET trade/v1/positions/{openId}
    positionHistory: true, // GET stat/v1/position/history
    orders: false, // no public order-level surface
    transfers: false, // no public balance-history surface
    copiers: true, // GET stat/v1/followers
  },

  /** One crawl per TF; the sortField prefix makes the server emit the
   *  window's s* headline fields (self-describing payloads — no composite
   *  wrapper needed for pure re-parsing). */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = lbankFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/stat/v1/getAll`)
    const pageSize = src.page_size ?? 20
    const sortField = TF_SORT[clampTf(timeframe)]
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?name=&size=${pageSize}&current=${pageIndex}&topFlag=0` +
          `&hiddenFullFlag=0&sortField=${sortField}&sortDirection=1`,
        method: 'GET',
        headers: {},
      }),
      extractMeta: (payload) => {
        const parsed = parseLbankLeaderboardPage(payload, dummyCtx(src))
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
   * Profile bundle per TF (6 replayed requests): identity + window-scoped
   * Performance block + PnL%/PnL/volume charts + token-preference donut.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = lbankFetcher(session)
    const tf = clampTf(timeframe)
    const id = encodeURIComponent(exchangeTraderId)
    const get = (url: string) => replayJson(session, fetcher, { url, method: 'GET', headers: {} })
    const post = (url: string, body: unknown) =>
      replayJson(session, fetcher, { url, method: 'POST', headers: {}, body })

    const headInfo = await get(`${endpoint(src, 'headInfo', `${BASE}/stat/v1`)}/${id}/head/info`)
    const stat = await get(
      `${endpoint(src, 'stat', `${BASE}/stat/v1/get`)}?type=${TF_TYPE[tf]}&traderId=${id}`
    )
    const body = { openId: exchangeTraderId, periodType: TF_PERIOD[tf] }
    const profitRateChart = await post(
      endpoint(src, 'profitRateChart', `${BASE}/stat/v1/queryProfitRate`),
      body
    )
    const profitChart = await post(
      endpoint(src, 'profitChart', `${BASE}/stat/v1/queryProfit`),
      body
    )
    const volumeChart = await post(
      endpoint(src, 'volumeChart', `${BASE}/stat/v1/queryTradeVolume`),
      body
    )
    const tradePreference = await post(
      endpoint(src, 'tradePreference', `${BASE}/stat/v1/queryTradePreference`),
      body
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            headInfo,
            stat,
            profitRateChart,
            profitChart,
            volumeChart,
            tradePreference,
            timeframe: tf,
          },
          url: `${BASE}/stat/v1/get`,
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
    const url = `${endpoint(src, 'positions', `${BASE}/trade/v1/positions`)}/${encodeURIComponent(exchangeTraderId)}`
    const payload = await replayJson(session, lbankFetcher(session), {
      url,
      method: 'GET',
      headers: {},
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Order History: newest-first numeric pages over a seconds-epoch window
   * (cursor → startTime; cold start = 180 days). Copiers: snapshot-style
   * full pagination via reported total.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history' && kind !== 'copiers') {
      throw new Error(`[lbank] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = lbankFetcher(session)
    const ctx = dummyCtx(src)
    const id = encodeURIComponent(exchangeTraderId)
    const limit = 20

    if (kind === 'position_history') {
      const url = endpoint(src, 'positionHistory', `${BASE}/stat/v1/position/history`)
      const endTime = Math.floor(Date.now() / 1000)
      const startTime = cursor
        ? Math.floor(new Date(cursor).getTime() / 1000) - 86_400 // 1d overlap
        : endTime - 180 * 86_400
      const maxPages = Number(src.meta.history_max_pages) || 20
      for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const payload = await replayJson(session, fetcher, {
          url:
            `${url}?instrumentID=&size=${limit}&current=${pageIndex}` +
            `&traderId=${id}&startTime=${startTime}&endTime=${endTime}`,
          method: 'GET',
          headers: {},
        })
        const rows = parseLbankHistory(payload, 'position_history', ctx)
        if (rows.length === 0) return
        yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
        if (rows.length < limit) return // last (short) page
      }
      return
    }

    // copiers
    const url = endpoint(src, 'copiers', `${BASE}/stat/v1/followers`)
    const maxPages = Number(src.meta.copier_max_pages) || 30
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?current=${pageIndex}&size=${limit}&traderId=${id}`,
        method: 'GET',
        headers: {},
      })
      const rows = parseLbankHistory(payload, 'copiers', ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      if (rows.length < limit) return
    }
  },

  parseLeaderboard: parseLbankLeaderboardPage,
  parseProfile: parseLbankProfile,
  parsePositions: parseLbankPositions,
  parseHistory: parseLbankHistory,
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

registerAdapter(lbankAdapter)

export { lbankAdapter }
