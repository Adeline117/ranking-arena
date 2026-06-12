/**
 * XT adapter (spec §11.13) — one adapter serves xt_futures + xt_spot via
 * src.meta.boardKey. Public unsigned JSON API (no signing, unlike BingX).
 *
 * Endpoints (verified by live capture 2026-06-11):
 *   futures board:  GET /fapi/user/v1/public/copy-trade/leader-list-v3
 *                     ?page&ps&days={7|30|90}&sortType=INCOME&sortDirection=DESC
 *                     — result.{total, items}; real page+ps pagination (ps≤100).
 *   spot board:     GET /sapi/v4/account/public/copy-trade/leader-list-v2
 *                     ?sortType=INCOME_RATE&days&sortDirection=DESC&limit
 *                     — `limit` returns the top-N (page/offset ignored); fetched
 *                     in ONE big-limit request, placeholders dropped by the parser.
 *   profile (both): GET .../leader-detail-v2?accountId — identity + overview
 *
 * The "View All Traders" link (spec §11.13) is the SPA route to these full
 * boards — leader-list-v2's bare form only returns the featured top-10, so we
 * hit the v3 (futures) / limit-form v2 (spot) endpoints directly. XT spot pads
 * its tail with all-zero placeholder rows once real traders run out (spec
 * §5.6) — parseXtLeaderboardPage drops them for the spot board.
 *
 * GAP (documented): the per-trader profile page (Copy Trading Overview per-TF
 * charts, Current Orders / History / Follower tabs) lives behind a
 * click-guarded SPA route whose JSON endpoints were not cleanly capturable
 * headless. Per-TF stats are fully covered by the per-TF board crawl
 * (income/incomeRate/winRate/maxRetraction/followerProfit + cumulative chart
 * land in leaderboard_entries.raw); positions/histories/copiers are left
 * disabled until that route is reached (likely on the VPS with a real click).
 *
 * WORKER-ONLY MODULE (imported via adapters/register in the worker).
 */

import type {
  HistoryKind,
  ParsedHistoryRow,
  ParsedPosition,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  Timeframe,
} from '../../core/types'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { apiFetcher, replayJson, replayPaged } from '../../fetch/capture'
import { parseXtLeaderboardPage, parseXtLeaderboardSeries, parseXtProfile } from './parsers'

const ORIGIN = 'https://www.xt.com'
const BASES: Record<string, string> = {
  futures: `${ORIGIN}/fapi/user/v1/public/copy-trade`,
  spot: `${ORIGIN}/sapi/v4/account/public/copy-trade`,
}
const HEADERS = { accept: 'application/json' }

function boardKey(src: SourceRow): 'futures' | 'spot' {
  return src.meta.boardKey === 'spot' ? 'spot' : 'futures'
}

function base(src: SourceRow): string {
  const override = (src.meta.endpoints as Record<string, string> | undefined)?.base
  return override ?? BASES[boardKey(src)]
}

const xtAdapter: SourceAdapter = {
  slug: 'xt',
  capabilities: {
    profile: true,
    // SPA-route-gated surfaces (see module header GAP). Per-TF stats are
    // delivered by the board crawl, not these.
    positions: false,
    positionHistory: false,
    orders: false,
    transfers: false,
    copiers: false,
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const fetcher = apiFetcher(await session.api())
    const ctx = () => ({
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt: new Date().toISOString(),
      meta: src.meta,
    })

    // Spot: a single big-limit fetch covers the small board; the API ignores
    // page/offset and pads the tail with all-zero placeholders (dropped by
    // the parser). No real pagination, so no replayPaged.
    if (boardKey(src) === 'spot') {
      const limit = Number(src.meta.spot_limit) || 200
      const url =
        `${base(src)}/leader-list-v2?sortType=INCOME_RATE&days=${timeframe}` +
        `&sortDirection=DESC&limit=${limit}&canFollow=false&nickName=&elite=false`
      const payload = await replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })
      yield { pageIndex: 1, payload, url, fetchedAt: new Date().toISOString() }
      return
    }

    // Futures: real page+ps pagination with result.total for the completeness
    // assertion. ps up to 100 keeps the crawl to ~19 pages for ~1,873 traders.
    const ps = src.page_size ?? 100
    const listUrl = `${base(src)}/leader-list-v3`
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url:
          `${listUrl}?page=${pageIndex}&ps=${ps}&sortType=INCOME&days=${timeframe}` +
          `&sortDirection=DESC&canFollow=false&nickName=&elite=false`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseXtLeaderboardPage(payload, ctx())
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize: ps,
    })) {
      yield page
      pagesYielded += 1
      if (maxPages !== null && pagesYielded >= maxPages) return
    }
  },

  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const fetcher = apiFetcher(await session.api())
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const detail = await replayJson(session, fetcher, {
      url: `${base(src)}/leader-detail-v2?accountId=${exchangeTraderId}`,
      method: 'GET',
      headers: HEADERS,
    })
    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detail, timeframe: tf },
          url: `${base(src)}/leader-detail-v2`,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  // SPA-route-gated surfaces — disabled (see module header GAP).
  async getPositions(): Promise<RawBundle> {
    return { pages: [], fetchedAt: new Date().toISOString() }
  },

  async *getHistory(): AsyncIterable<RawPage> {
    return
  },

  parseLeaderboard: parseXtLeaderboardPage,
  parseLeaderboardSeries: parseXtLeaderboardSeries,
  parseProfile: parseXtProfile,
  parsePositions: (): ParsedPosition[] => [],
  parseHistory: (_raw: unknown, _kind: HistoryKind): ParsedHistoryRow[] => [],
}

registerAdapter(xtAdapter)

export { xtAdapter }
