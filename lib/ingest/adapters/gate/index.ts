/**
 * Gate adapter (spec §11.10 futures / §11.11 CFD) — one adapter serves
 * gate_futures + gate_cfd via src.meta.boardKey (bitget/binance pattern).
 *
 * Endpoints (verified by live capture 2026-06-11):
 *   futures list: GET /apiw/v2/copy/leader/list?...&full_ranking=1&cycle={tok}
 *     TF tokens: 7→seven, 30→month, 90→threemonth (the "hidden" filter-modal
 *     TF picker, spec §11.10) — totalcount/pagecount in data.
 *   futures profile: trader/detail/{id} (ALL TF blocks in one response,
 *     session-cached) + leader/profit_chart?data_type={tok}
 *     + trader/position_composition?data_type={tok}
 *   futures surfaces: leader/position, leader/close_position,
 *     leader/history_order_list, leader/transfer_records,
 *     trader/follow_user (top-10 only, spec §11.10)
 *   cfd (tradfi family, USDx): copy_tradfi/leader/list?cycle={7|30|90},
 *     trade/info + lead/info + yield (profile), positions/history,
 *     public/followers. copy_tradfi positions + transfer_records are
 *     auth-gated (无效参数 用户 ID) — not crawlable publicly.
 *
 * Akamai fronts gate.com: the bundled Chromium TLS fingerprint is denied
 * ("Access Denied"), so sessions must run browser_channel=chrome
 * (sources.meta.browser_channel) and replay goes through pageFetcher
 * (in-page same-origin fetch).
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
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { pageFetcher, replayJson, replayPaged } from '../../fetch/capture'
import {
  parseGateHistory,
  parseGateLeaderboardPage,
  parseGatePositions,
  parseGateProfile,
} from './parsers'

const B = 'https://www.gate.com'
const FUT_CYCLE: Record<number, string> = { 7: 'seven', 30: 'month', 90: 'threemonth' }
const HEADERS = { accept: 'application/json' }

function endpoint(src: SourceRow, key: string, fallback: string): string {
  const endpoints = (src.meta.endpoints ?? {}) as Record<string, string>
  return endpoints[key] ?? fallback
}

function boardKey(src: SourceRow): 'futures' | 'cfd' {
  return src.meta.boardKey === 'cfd' ? 'cfd' : 'futures'
}

/** One warm page load per session establishes Akamai cookies; everything
 *  after is same-origin JSON replay (spec §2.2). */
const warmedSessions = new WeakSet<FetchSession>()

async function warmSession(session: FetchSession, src: SourceRow): Promise<void> {
  if (warmedSessions.has(session)) return
  const page = await session.page()
  const url = src.leaderboard_url ?? `${B}/zh/copytrading`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    // best-effort — a busy page still yields valid cookies
  })
  warmedSessions.add(session)
}

/** Session-scoped cache for TF-independent payloads (futures detail / cfd
 *  lead-info) — Tier-B hits each trader 3 TFs back to back. */
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
  if (cache.size > 50) cache.clear()
  cache.set(key, value)
  return value
}

function futListUrl(src: SourceRow, tf: RankingTimeframe, pageIndex: number): string {
  const base = endpoint(src, 'list', `${B}/apiw/v2/copy/leader/list`)
  const pageSize = src.page_size ?? 12
  return (
    `${base}?sub_website_id=0&order_by=profit_rate&sort_by=desc&is_curated=0` +
    `&private_type=0&cycle=${FUT_CYCLE[tf]}&label_ids=&status=running&style_label_code=` +
    `&full_ranking=1&smart_filter=0&profit_type=total_profit&cycle_type=total` +
    `&max_profit=5000000&min_profit=0&max_follow_profit=5000000&min_follow_profit=0` +
    `&page=${pageIndex}&page_size=${pageSize}&is_favorite=false`
  )
}

function cfdListUrl(src: SourceRow, tf: RankingTimeframe, pageIndex: number): string {
  const base = endpoint(src, 'list', `${B}/apiw/v2/copy_tradfi/leader/list`)
  const pageSize = src.page_size ?? 12
  return (
    `${base}?sub_website_id=0&page=${pageIndex}&page_size=${pageSize}` +
    `&order_by=follow_profit&sort_by=desc&cycle=${tf}&is_favorite=false`
  )
}

const gateAdapter: SourceAdapter = {
  slug: 'gate',
  capabilities: {
    profile: true,
    positions: true, // futures only; gate_cfd keeps positions_topn=0 (auth-gated)
    positionHistory: true,
    orders: true, // futures 成交记录; cfd yields nothing
    transfers: true, // futures 划转记录; cfd auth-gated → yields nothing
    copiers: true, // futures top-10 only; cfd public/followers
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const board = boardKey(src)
    const pageSize = src.page_size ?? 12
    // Validation knob: src.meta.max_pages caps the crawl (smoke runs). Early
    // generator return — replayPaged never sees a truncation, so its
    // completeness assertion stays scoped to real crawls.
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          board === 'cfd'
            ? cfdListUrl(src, timeframe, pageIndex)
            : futListUrl(src, timeframe, pageIndex),
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseGateLeaderboardPage(payload, {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt: new Date().toISOString(),
          meta: src.meta,
        })
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
   * Futures: detail (TF-independent, cached) + profit_chart + composition.
   * CFD: trade/info per TF + lead/info (cached) + yield curves.
   * Composite payloads keep parseProfile a pure function of stored RAW.
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
    const fetchedAt = new Date().toISOString()

    if (boardKey(src) === 'cfd') {
      const tradeInfo = await replayJson(session, fetcher, {
        url:
          endpoint(src, 'tradeInfo', `${B}/apiw/v2/copy_tradfi/leader/trade/info`) +
          `?sub_website_id=0&leader_id=${exchangeTraderId}&cycle=${tf}`,
        method: 'GET',
        headers: HEADERS,
      })
      const leadInfo = await cached(session, `cfd:${exchangeTraderId}`, () =>
        replayJson(session, fetcher, {
          url:
            endpoint(src, 'leadInfo', `${B}/apiw/v2/copy_tradfi/leader/lead/info`) +
            `?sub_website_id=0&leader_id=${exchangeTraderId}`,
          method: 'GET',
          headers: HEADERS,
        })
      )
      const yieldData = await replayJson(session, fetcher, {
        url:
          endpoint(src, 'yield', `${B}/apiw/v2/copy_tradfi/leader/yield`) +
          `?sub_website_id=0&leader_ids=${exchangeTraderId}&cycle=${tf}`,
        method: 'GET',
        headers: HEADERS,
      })
      return {
        pages: [
          {
            pageIndex: 1,
            payload: { tradeInfo, leadInfo, yieldData, timeframe: tf },
            url: `${B}/apiw/v2/copy_tradfi/leader/trade/info`,
            fetchedAt,
          },
        ],
        fetchedAt,
      }
    }

    const detail = await cached(session, `fut:${exchangeTraderId}`, () =>
      replayJson(session, fetcher, {
        url:
          endpoint(src, 'detail', `${B}/api/copytrade/copy_trading/trader/detail`) +
          `/${exchangeTraderId}?sub_website_id=0&leaderId=${exchangeTraderId}`,
        method: 'GET',
        headers: HEADERS,
      })
    )
    const profitChart = await replayJson(session, fetcher, {
      url:
        endpoint(src, 'profitChart', `${B}/apiw/v2/copy/leader/profit_chart`) +
        `?sub_website_id=0&leader_id=${exchangeTraderId}&data_type=${FUT_CYCLE[tf]}`,
      method: 'GET',
      headers: HEADERS,
    })
    const positionComposition = await replayJson(session, fetcher, {
      url:
        endpoint(
          src,
          'composition',
          `${B}/api/copytrade/copy_trading/trader/position_composition`
        ) + `?sub_website_id=0&leader_id=${exchangeTraderId}&data_type=${FUT_CYCLE[tf]}`,
      method: 'GET',
      headers: HEADERS,
    })

    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detail, profitChart, positionComposition, timeframe: tf },
          url: `${B}/api/copytrade/copy_trading/trader/detail/${exchangeTraderId}`,
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
    const fetchedAt = new Date().toISOString()
    if (boardKey(src) === 'cfd') {
      // copy_tradfi/leader/positions demands a logged-in user (无效参数 用户
      // ID) — gate_cfd keeps positions_topn=0; this guard is belt-and-braces.
      return { pages: [], fetchedAt }
    }
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const url =
      endpoint(src, 'positions', `${B}/apiw/v2/copy/leader/position`) +
      `?sub_website_id=0&leader_id=${exchangeTraderId}&market=&page=1&page_size=50`
    const payload = await replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /**
   * Incremental histories, newest→oldest (spec §2.3). Futures rows are
   * plain arrays (no nextFlag): stop on short page or cursor overlap.
   * CFD position history pages via data.{list, pagecount}.
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    const board = boardKey(src)
    // CFD: orders + transfers are auth-gated — yield nothing (caller skips).
    if (board === 'cfd' && (kind === 'orders' || kind === 'transfers')) return
    await warmSession(session, src)
    const fetcher = pageFetcher(session)
    const pageSize = 10
    const maxPages = Number(src.meta.history_max_pages ?? 25) || 25
    const cursorMs = cursor ? Date.parse(cursor) : NaN

    const urlFor = (pageNo: number): string => {
      if (board === 'cfd') {
        return kind === 'position_history'
          ? endpoint(src, 'positionHistory', `${B}/apiw/v2/copy_tradfi/leader/positions/history`) +
              `?sub_website_id=0&leader_id=${exchangeTraderId}&page=${pageNo}&page_size=${pageSize}`
          : endpoint(src, 'copiers', `${B}/apiw/v2/copy_tradfi/leader/public/followers`) +
              `?sub_website_id=0&leader_id=${exchangeTraderId}&page=${pageNo}&page_size=${pageSize}`
      }
      switch (kind) {
        case 'position_history':
          return (
            endpoint(src, 'positionHistory', `${B}/apiw/v2/copy/leader/close_position`) +
            `?sub_website_id=0&leader_id=${exchangeTraderId}&market=&page=${pageNo}&page_size=${pageSize}`
          )
        case 'orders':
          return (
            endpoint(src, 'orders', `${B}/apiw/v2/copy/leader/history_order_list`) +
            `?sub_website_id=0&leader_id=${exchangeTraderId}&market=&page=${pageNo}&page_size=${pageSize}`
          )
        case 'transfers':
          return (
            endpoint(src, 'transfers', `${B}/apiw/v2/copy/leader/transfer_records`) +
            `?sub_website_id=0&leader_id=${exchangeTraderId}&page=${pageNo}&page_size=${pageSize}`
          )
        case 'copiers':
          // top-10 only (spec §11.10) — single page covers the surface
          return (
            endpoint(src, 'copiers', `${B}/api/copytrade/copy_trading/trader/follow_user`) +
            `?sub_website_id=0&leader_id=${exchangeTraderId}&page_size=${pageSize}&page=${pageNo}&status=running`
          )
        default:
          throw new Error(`[gate] history surface ${kind} not supported`)
      }
    }

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const url = urlFor(pageNo)
      const payload = await replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })
      const data = (payload as Record<string, unknown>)?.data
      const rows = Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : Array.isArray((data as Record<string, unknown>)?.list)
          ? ((data as Record<string, unknown>).list as Array<Record<string, unknown>>)
          : []
      if (rows.length === 0) break

      yield { pageIndex: pageNo, payload, url, fetchedAt: new Date().toISOString() }

      if (rows.length < pageSize) break
      // Futures copiers surface is top-10 only — never paginate past page 1.
      if (board === 'futures' && kind === 'copiers') break
      if (kind === 'position_history' && Number.isFinite(cursorMs)) {
        const closeKey = board === 'cfd' ? 'close_time' : 'create_time'
        const closeTimes = rows
          .map((r) => Number(r[closeKey]) * 1000)
          .filter((t) => Number.isFinite(t) && t > 0)
        // Overlap reached: this page already dips into stored history.
        if (closeTimes.length > 0 && Math.min(...closeTimes) <= cursorMs) break
      }
    }
  },

  parseLeaderboard: parseGateLeaderboardPage,
  parseProfile: parseGateProfile,
  parsePositions: parseGatePositions,
  parseHistory: parseGateHistory,
}

registerAdapter(gateAdapter)

export { gateAdapter }
