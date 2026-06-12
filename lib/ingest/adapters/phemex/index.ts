/**
 * Phemex Futures copy-trading adapter (spec §7 #30 / §11.19).
 * Board URL: https://phemex.com/copy-trading/list?t=r
 * Profile URL: /copy-trading/follower-view/home?id={userId}
 *
 * FETCH MODEL (unique among batch-1 sources): the API host
 * (api10.phemex.com) rejects both in-page cross-origin fetch AND bare
 * APIRequestContext calls (403 HTML), but accepts APIRequestContext replay
 * when it carries the page's own captured request headers (the `bid`
 * device-id header is the key — verified 2026-06-11). warmSession therefore
 * captures one live phemex-lb request during the board page load and every
 * replay merges those headers.
 *
 * Endpoints (base api10.phemex.com/phemex-lb/public/data):
 *   list:      GET v3/user/recommend?…&pageNum&pageSize≤50&sortBy=
 *              (one endpoint serves the 30d AND 90d boards — rows carry both
 *              field variants; TF dropdown is client-side. NO 7d board.)
 *   AI roster: GET v3/ai-trader/list?lang=en → house AI bots (spec §11.19
 *              carousel) appended as a final composite page, bot/ai rows.
 *   profile:   GET v3/user + user/pnl-rate-chart?period={30,90} +
 *              user/pnl-chart?period={30,90} + v3/user/symbol-metric
 *   positions: GET position/current/v2?pageNum&pageSize&userId
 *   history:   GET position/closed/v2?pageNum&pageSize&userId
 *   Commentary tab: SKIPPED (spec §11.19). No public copier table.
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
  parsePhemexHistory,
  parsePhemexLeaderboardPage,
  parsePhemexPositions,
  parsePhemexProfile,
} from './parsers'

const BASE = 'https://api10.phemex.com/phemex-lb/public/data'

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

/** Captured page-request headers per session (see FETCH MODEL above). */
const sessionHeaders = new WeakMap<FetchSession, Record<string, string>>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (sessionHeaders.has(session)) return
  const capture = await session.capture(/phemex-lb\/public\/data/)
  try {
    const page = await session.page()
    const url = src.leaderboard_url ?? 'https://phemex.com/copy-trading/list?t=r'
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const exchange = await capture.first(45_000)
    sessionHeaders.set(session, exchange.template.headers)
  } finally {
    capture.dispose()
  }
}

/** APIRequestContext replay carrying the captured page headers. */
function phemexFetcher(session: FetchSession): JsonFetcher {
  return async (template) => {
    const api = await session.api()
    const headers = { ...(sessionHeaders.get(session) ?? {}), ...template.headers }
    const response = await api.get(template.url, { headers })
    let json: unknown = null
    try {
      json = await response.json()
    } catch {
      // non-JSON body (403 HTML block page) — caller decides
    }
    return { status: response.status(), json }
  }
}

const phemexAdapter: SourceAdapter = {
  slug: 'phemex',
  capabilities: {
    profile: true,
    positions: true, // GET position/current/v2
    positionHistory: true, // GET position/closed/v2
    orders: false, // no public order-level surface
    transfers: false, // no public balance-history surface
    copiers: false, // aggregate Copiers' Profit only — no copier table
  },

  /**
   * One crawl per TF over the same endpoint (rows carry both TF variants);
   * pages are wrapped as { board, timeframe } composites so the pure parser
   * picks the right variant. The house AI carousel is appended as a final
   * { aiList, timeframe } page (additive — its failure must not kill Tier A).
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = phemexFetcher(session)
    const listUrl = endpoint(src, 'list', `${BASE}/v3/user/recommend`)
    const pageSize = src.page_size ?? 50 // server cap: 50
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    let truncated = false
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?hideFullyCopied=false&keyword=&pageNum=${pageIndex}` +
          `&pageSize=${pageSize}&showChart=false&sortBy=`,
        method: 'GET',
        headers: {},
      }),
      extractMeta: (payload) => {
        const parsed = parsePhemexLeaderboardPage({ board: payload, timeframe }, dummyCtx(src))
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
    })) {
      yield { ...page, payload: { board: page.payload, timeframe } }
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) {
        truncated = true
        break
      }
    }

    if (!truncated) {
      const aiUrl = endpoint(src, 'aiList', `${BASE}/v3/ai-trader/list`)
      try {
        const aiList = await replayJson(session, fetcher, {
          url: `${aiUrl}?lang=en`,
          method: 'GET',
          headers: {},
        })
        yield {
          pageIndex: pagesYielded + 1,
          payload: { aiList, timeframe },
          url: aiUrl,
          fetchedAt: new Date().toISOString(),
        }
      } catch (err) {
        console.warn(
          `[phemex] AI carousel fetch failed (board published without AI rows):`,
          err instanceof Error ? err.message : err
        )
      }
    }
  },

  /**
   * Profile bundle per TF (4 replayed GETs): v3/user stats blocks (genuinely
   * TF-variant fields) + ROI chart + PNL chart + preference donut.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    await warmSession(session, src)
    const fetcher = phemexFetcher(session)
    const tf = timeframe === 90 || timeframe === 0 ? 90 : 30
    const id = encodeURIComponent(exchangeTraderId)
    const get = (url: string) => replayJson(session, fetcher, { url, method: 'GET', headers: {} })

    const user = await get(`${endpoint(src, 'user', `${BASE}/v3/user`)}?lang=en&userId=${id}`)
    const pnlRateChart = await get(
      `${endpoint(src, 'pnlRateChart', `${BASE}/user/pnl-rate-chart`)}?period=${tf}&userId=${id}`
    )
    const pnlChart = await get(
      `${endpoint(src, 'pnlChart', `${BASE}/user/pnl-chart`)}?period=${tf}&userId=${id}`
    )
    const symbolMetric = await get(
      `${endpoint(src, 'symbolMetric', `${BASE}/v3/user/symbol-metric`)}?userId=${id}`
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { user, pnlRateChart, pnlChart, symbolMetric, timeframe: tf },
          url: `${BASE}/v3/user`,
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
    const url = endpoint(src, 'positions', `${BASE}/position/current/v2`)
    // pageSize 20 = the site's own request; >20 open lead positions is rare.
    const payload = await replayJson(session, phemexFetcher(session), {
      url: `${url}?pageNum=1&pageSize=20&userId=${encodeURIComponent(exchangeTraderId)}`,
      method: 'GET',
      headers: {},
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Historical positions: newest-first numeric pages; stop on empty/short
   * page, on cursor overlap (oldest updatedTime ≤ cursor), or at the cap.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind !== 'position_history') {
      throw new Error(`[phemex] history surface ${kind} not supported`)
    }
    await warmSession(session, src)
    const fetcher = phemexFetcher(session)
    const ctx = dummyCtx(src)
    const url = endpoint(src, 'positionHistory', `${BASE}/position/closed/v2`)
    const limit = 20
    const maxPages = Number(src.meta.history_max_pages) || 20

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?pageNum=${pageIndex}&pageSize=${limit}&userId=${encodeURIComponent(exchangeTraderId)}`,
        method: 'GET',
        headers: {},
      })
      const rows = parsePhemexHistory(payload, 'position_history', ctx)
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

  parseLeaderboard: parsePhemexLeaderboardPage,
  parseProfile: parsePhemexProfile,
  parsePositions: parsePhemexPositions,
  parseHistory: parsePhemexHistory,
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

registerAdapter(phemexAdapter)

export { phemexAdapter }
