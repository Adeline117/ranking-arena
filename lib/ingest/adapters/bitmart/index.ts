/**
 * BitMart AIHub copy-trading adapter (spec §7 #36 / §11.21).
 * Board URL: https://www.bitmart.com/en-US/ai/copy-trading
 * Profile URL: /en-US/ai/copy-trading/master-detail/{uuid}
 *
 * FETCH MODEL: fetch_region MUST be vps_sg — www.bitmart.com serves an
 * interactive Cloudflare Turnstile to this Mac Mini's IP (HTML and gw-api
 * alike, verified 2026-06-12) but the SG VPS egress passes clean. The
 * gw-api accepts plain APIRequestContext replay with NO cookies as long as
 * every request carries `x-bm-contract: 2` (the V2 selector — without it
 * the gateway answers "Futures V1 has been deprecated").
 *
 * Endpoints (base www.bitmart.com/gw-api/contract-tiger/forward/v1/ifcontract):
 *   list:      GET copytrade-streamer/master/master-ranking?page&size&order=5
 *              &window_type={2|3}&comment_switch=true&chart_switch=false
 *              &master_type=1  — window_type 1=24H 2=7D 3=1M (NO 3M board;
 *              the 90d board is derived from sheet stats, spec §1.1-C).
 *              `total` includes hidden masters: pages are post-filtered, so
 *              the crawl runs to ceil(total/size) instead of short-page.
 *   profile:   copytrade-entry/master/getByUUID + copytrade-streamer/
 *              {master/key-metric, master/aum/info, sheet, chart,
 *               asset-preferences, master/radar/chart}
 *   positions: GET copytrade-streamer/position/list?uuid&page&size
 *   history:   GET copytrade-streamer/position/history/list (+ order/
 *              history/list, master/transferRecord)
 *   weekly arena (spec §11.21): arena/available-weeks + arena/roi-ranking
 *              ?window_type=2&master_type={1|2|3}&year&week → persisted to
 *              sources.meta.weekly_arena_latest (jsonb blob, spec note);
 *              Beacon AI commentary TEXT is never ingested (spec §14).
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
import { apiFetcher, replayJson, type JsonFetcher } from '../../fetch/capture'
import { getIngestPool } from '../../db'
import {
  parseBitmartHistory,
  parseBitmartLeaderboardPage,
  parseBitmartPositions,
  parseBitmartProfile,
} from './parsers'

const BASE = 'https://www.bitmart.com/gw-api/contract-tiger/forward/v1/ifcontract'
const STREAMER = `${BASE}/copytrade-streamer`

/** x-bm-contract: 2 is MANDATORY (V2 gateway selector — see header). */
const HEADERS = {
  accept: 'application/json',
  'x-bm-contract': '2',
  'x-bm-client': 'WEB',
  'x-bm-local': 'en_US',
  'x-bm-timezone': 'UTC',
  'x-bm-timezone-offset': '0',
}

/** Board windows: 1=24H (ignored), 2=7D, 3=1M. No 3M board (derived). */
const BOARD_WINDOW: Record<number, number> = { 7: 2, 30: 3 }
/** chart / asset-preferences / sheet window enum: 2=7D, 3=1M, 4=3M. */
const PROFILE_WINDOW: Record<number, number> = { 7: 2, 30: 3, 90: 4 }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

async function bitmartFetcher(session: FetchSession): Promise<JsonFetcher> {
  return apiFetcher(await session.api())
}

/**
 * Weekly Master ROI Arena (spec §11.21): current week's podium for the
 * three categories (1=Open / 2=Low Lev / 3=Protected Ranked) → persisted
 * as a jsonb blob on sources.meta.weekly_arena_latest ("for now" surface —
 * no dedicated table yet). Additive: failures must never fail Tier A.
 */
async function captureWeeklyArena(
  session: FetchSession,
  fetcher: JsonFetcher,
  src: SourceRow
): Promise<void> {
  try {
    const weeksUrl = endpoint(src, 'arenaWeeks', `${STREAMER}/arena/available-weeks`)
    const weeks = (await replayJson(session, fetcher, {
      url: weeksUrl,
      method: 'GET',
      headers: HEADERS,
    })) as { data?: { list?: Array<Record<string, unknown>> } }
    const current = (weeks?.data?.list ?? []).find((w) => w.is_current_week === true)
    if (!current) return

    const rankingUrl = endpoint(src, 'arenaRanking', `${STREAMER}/arena/roi-ranking`)
    const categories: Record<string, unknown> = {}
    const names: Record<number, string> = { 1: 'open', 2: 'low_lev', 3: 'protected' }
    for (const masterType of [1, 2, 3]) {
      const payload = (await replayJson(session, fetcher, {
        url:
          `${rankingUrl}?window_type=2&master_type=${masterType}` +
          `&year=${current.year}&week=${current.week}`,
        method: 'GET',
        headers: HEADERS,
      })) as { data?: unknown }
      categories[names[masterType]] = payload?.data ?? null
    }

    const blob = {
      fetched_at: new Date().toISOString(),
      week: current,
      categories, // each: { list:[{rank-ordered master, weekly roi}], week_info }
    }
    await getIngestPool().query(
      `UPDATE arena.sources
          SET meta = jsonb_set(meta, '{weekly_arena_latest}', $1::jsonb)
        WHERE id = $2`,
      [JSON.stringify(blob), src.id]
    )
    console.warn(
      `[bitmart] weekly arena ${String(current.year)}-W${String(current.week)} captured ` +
        `(${Object.keys(categories).length} categories)`
    )
  } catch (err) {
    // Additive surface — never fail the board crawl over it.
    console.warn(
      `[bitmart] weekly arena capture failed (board unaffected):`,
      err instanceof Error ? err.message : err
    )
  }
}

const bitmartAdapter: SourceAdapter = {
  slug: 'bitmart',
  capabilities: {
    profile: true,
    positions: true, // GET position/list
    positionHistory: true, // GET position/history/list
    orders: true, // GET order/history/list
    transfers: true, // GET master/transferRecord
    copiers: false, // follower list is auth-only ("Forbidden|empty token")
  },

  /**
   * One crawl per native TF (7d window_type=2 / 30d window_type=3). The
   * server's `total` counts hidden masters and every page is post-filtered,
   * so we paginate to ceil(total/size) and tolerate short/empty pages
   * mid-crawl (replayPaged's short-page stop rule would truncate here).
   */
  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const windowType = BOARD_WINDOW[timeframe]
    if (windowType === undefined) {
      throw new Error(`[bitmart] no native ${timeframe}d board — 90d is a derived board`)
    }
    const fetcher = await bitmartFetcher(session)
    const listUrl = endpoint(src, 'list', `${STREAMER}/master/master-ranking`)
    const pageSize = src.page_size ?? 20
    const order = Number(src.meta.list_order) || 5 // site default sort
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs).
    const maxPages = Number(src.meta.max_pages) || null

    let totalPages: number | null = null
    for (let pageIndex = 1; ; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url:
          `${listUrl}?page=${pageIndex}&size=${pageSize}&order=${order}` +
          `&window_type=${windowType}&comment_switch=true&chart_switch=false&master_type=1`,
        method: 'GET',
        headers: HEADERS,
      })
      const parsed = parseBitmartLeaderboardPage(payload, dummyCtx(src))
      if (totalPages === null && parsed.reportedTotal !== null) {
        totalPages = Math.ceil(parsed.reportedTotal / pageSize)
      }
      if (parsed.rows.length > 0) {
        yield { pageIndex, payload, url: listUrl, fetchedAt: new Date().toISOString() }
      }
      if (maxPages !== null && pageIndex >= maxPages) break
      if (pageIndex >= (totalPages ?? 1)) break
      if (pageIndex >= 50) break // hard safety cap
    }

    // Weekly Master ROI Arena rides on the 7d crawl (once per Tier-A cycle).
    if (timeframe === 7) await captureWeeklyArena(session, fetcher, src)
  },

  /**
   * Profile bundle per TF (7 replayed requests): identity + key metrics
   * (Latest NAV!) + AUM/copiers + Master Performance sheet + daily ROI/PnL
   * chart + asset-preference donut + rank rings. The sheet's 3M window
   * (window=4) is the SUBSTRATE of the derived 90d board.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const fetcher = await bitmartFetcher(session)
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const windowType = PROFILE_WINDOW[tf]
    const uuid = encodeURIComponent(exchangeTraderId)
    const get = (url: string) =>
      replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })

    const getByUuid = await get(
      `${endpoint(src, 'getByUuid', `${BASE}/copytrade-entry/master/getByUUID`)}?uuid=${uuid}`
    )
    const keyMetric = await get(
      `${endpoint(src, 'keyMetric', `${STREAMER}/master/key-metric`)}?uuid=${uuid}`
    )
    const aumInfo = await get(
      `${endpoint(src, 'aumInfo', `${STREAMER}/master/aum/info`)}?uuid=${uuid}`
    )
    const sheet = await get(`${endpoint(src, 'sheet', `${STREAMER}/sheet`)}?uuid=${uuid}`)
    const chart = await get(
      `${endpoint(src, 'chart', `${STREAMER}/chart`)}?uuid=${uuid}&window_type=${windowType}`
    )
    const assetPreferences = await get(
      `${endpoint(src, 'assetPreferences', `${STREAMER}/asset-preferences`)}?uuid=${uuid}&window_type=${windowType}`
    )
    const radar = await get(
      `${endpoint(src, 'radar', `${STREAMER}/master/radar/chart`)}?uuid=${uuid}`
    )

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: {
            getByUuid,
            keyMetric,
            aumInfo,
            sheet,
            chart,
            assetPreferences,
            radar,
            timeframe: tf,
          },
          url: `${STREAMER}/sheet`,
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
    const url =
      endpoint(src, 'positions', `${STREAMER}/position/list`) +
      `?uuid=${encodeURIComponent(exchangeTraderId)}&page=1&size=100`
    const payload = await replayJson(session, await bitmartFetcher(session), {
      url,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * position_history / orders / transfers: newest-first numeric pages; stop
   * on empty/short page, on cursor overlap or at the safety cap.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    if (kind === 'copiers') {
      throw new Error(`[bitmart] history surface ${kind} not supported (auth-only)`)
    }
    const fetcher = await bitmartFetcher(session)
    const ctx = dummyCtx(src)
    const uuid = encodeURIComponent(exchangeTraderId)
    const limit = 20
    const urls: Record<Exclude<HistoryKind, 'copiers'>, string> = {
      position_history: endpoint(src, 'positionHistory', `${STREAMER}/position/history/list`),
      orders: endpoint(src, 'orders', `${STREAMER}/order/history/list`),
      transfers: endpoint(src, 'transfers', `${STREAMER}/master/transferRecord`),
    }
    const url = urls[kind]
    const maxPages = Number(src.meta.history_max_pages) || 20

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
      const payload = await replayJson(session, fetcher, {
        url: `${url}?uuid=${uuid}&page=${pageIndex}&size=${limit}`,
        method: 'GET',
        headers: HEADERS,
      })
      const rows = parseBitmartHistory(payload, kind, ctx)
      if (rows.length === 0) return
      yield { pageIndex, payload, url, fetchedAt: new Date().toISOString() }
      if (rows.length < limit) return // last (short) page
      if (cursor !== null) {
        const oldest = rows[rows.length - 1]
        const oldestTs =
          oldest.kind === 'position_history' ? oldest.closedAt : 'ts' in oldest ? oldest.ts : null
        if (oldestTs && oldestTs <= cursor) return // overlap reached
      }
    }
  },

  parseLeaderboard: parseBitmartLeaderboardPage,
  parseProfile: parseBitmartProfile,
  parsePositions: parseBitmartPositions,
  parseHistory: parseBitmartHistory,
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

registerAdapter(bitmartAdapter)

export { bitmartAdapter }
