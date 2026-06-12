/**
 * Blofin adapter (spec §11.14) — one adapter serves blofin_futures +
 * blofin_spot via src.meta.boardKey. Public unsigned POST JSON API.
 *
 * Endpoints (verified by live capture 2026-06-11):
 *   futures board: POST /uapi/v1/copy/v2/trader/list
 *   spot board:    POST /sapi/v1/spot_copy/trader/list
 *   body: {sort_field:"roi", range_time:"1"|"2"|"3" (=7|30|90d), page_num,
 *          page_size (cap 20), trading_bots_type:[], tag_list:[], nick_name:"",
 *          hide_full_portfolios:0, sort_order:"DESC", pnl/copier bounds:""}
 *   data: {trader_info[], page_total, pages} — full per-TF stats per trader
 *         (roi/pnl/mdd/sharpe/aum/followers) + cumulative-ROI chart_data.
 *
 * The board carries per-TF stats + chart, so the leaderboard crawl satisfies
 * the per-TF profile-stats requirement on its own.
 *
 * GAPS (documented):
 *  - Profile/positions/histories/copiers: the per-trader profile (Statistical
 *    Data / Trades / Bots / Copiers tabs, Annualized ROI, Calmar/Sortino) is a
 *    click-guarded SPA route with NO reachable per-uid JSON endpoint
 *    (trader/list ignores any uid filter) — disabled until reached on the VPS.
 *  - Bot/human split + bot-scope chart series (spec §11.14 All|Trades|Bots):
 *    the board row has no per-row bot flag — only the trading_bots_type FILTER
 *    distinguishes them — so trader_kind defaults to human; a separate
 *    bot-filtered tagging pass is future work.
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
import { apiFetcher, replayPaged } from '../../fetch/capture'
import { parseBlofinLeaderboardPage } from './parsers'

const ORIGIN = 'https://blofin.com'
const LIST_PATHS: Record<string, string> = {
  futures: `${ORIGIN}/uapi/v1/copy/v2/trader/list`,
  spot: `${ORIGIN}/sapi/v1/spot_copy/trader/list`,
}
/** Canonical TF → Blofin range_time token. */
const RANGE_TIME: Record<number, string> = { 7: '1', 30: '2', 90: '3' }
const HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

function boardKey(src: SourceRow): 'futures' | 'spot' {
  return src.meta.boardKey === 'spot' ? 'spot' : 'futures'
}

function listUrl(src: SourceRow): string {
  const override = (src.meta.endpoints as Record<string, string> | undefined)?.list
  return override ?? LIST_PATHS[boardKey(src)]
}

const blofinAdapter: SourceAdapter = {
  slug: 'blofin',
  capabilities: {
    // Profile/surfaces are SPA-route-gated with no per-uid endpoint (see
    // module header GAPS). Per-TF stats are delivered by the board crawl.
    profile: false,
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
    const url = listUrl(src)
    const pageSize = src.page_size ?? 20
    const rangeTime = RANGE_TIME[timeframe] ?? '2'
    const maxPages = Number(src.meta.max_pages) || null

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url,
        method: 'POST',
        headers: HEADERS,
        body: {
          hide_full_portfolios: 0,
          sort_field: 'roi',
          range_time: rangeTime,
          sort_order: 'DESC',
          nick_name: '',
          trading_bots_type: [],
          tag_list: [],
          page_num: pageIndex,
          page_size: pageSize,
          pnl_lower: '',
          pnl_upper: '',
          copier_pnl_lower: '',
          copier_pnl_upper: '',
        },
      }),
      extractMeta: (payload) => {
        const parsed = parseBlofinLeaderboardPage(payload, {
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

  // SPA-route-gated surfaces — disabled (see module header GAPS).
  async getProfile(): Promise<RawBundle> {
    return { pages: [], fetchedAt: new Date().toISOString() }
  },
  async getPositions(): Promise<RawBundle> {
    return { pages: [], fetchedAt: new Date().toISOString() }
  },
  async *getHistory(): AsyncIterable<RawPage> {
    return
  },

  parseLeaderboard: parseBlofinLeaderboardPage,
  parseProfile: () => ({ stats: [], series: [], nickname: null, avatarUrlOrigin: null }),
  parsePositions: (): ParsedPosition[] => [],
  parseHistory: (_raw: unknown, _kind: HistoryKind): ParsedHistoryRow[] => [],
}

registerAdapter(blofinAdapter)

export { blofinAdapter }
