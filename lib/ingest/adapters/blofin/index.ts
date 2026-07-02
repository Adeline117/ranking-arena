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
 * Profile (harvested via headful capture 2026-07-02 — the detail SPA route is
 *   /copy-trade/details/{uid}?module=futures, anti-bot on the PAGE but the
 *   underlying uapi endpoints are unsigned POST + reachable direct):
 *     POST /uapi/v1/copy/trader/info                {uid}
 *     POST /uapi/v1/copy/trader/stat/indicators     {uid, stat_period:D7|D30|D90}
 *          → sharpe_ratio/sortino_ratio/calmar_ratio/volatility/annualized_roi/
 *            max_drawdown/win_ratio/trades/winning_trades/real_pnl (NOT on board!)
 *     POST /uapi/v1/copy/trader/stat/symbol_performance {uid, stat_period, type:"all"}
 *          → per-symbol trades/win_ratio (trading preferences)
 *     POST /uapi/v1/copy/trader/stat/performance    {uid, stat_period, type:"all"}
 *          → roi/pnl time-series (chart)
 *
 * GAPS (documented):
 *  - Positions/histories/copiers records: the Trades/Copiers tabs' record
 *    endpoints weren't surfaced in the capture (login-gated copiers, positions
 *    need deeper tab nav) — future work; stats/charts/preferences are covered.
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
import { apiFetcher, replayJson, replayPaged } from '../../fetch/capture'
import {
  parseBlofinLeaderboardPage,
  parseBlofinLeaderboardSeries,
  parseBlofinProfile,
} from './parsers'

const ORIGIN = 'https://blofin.com'
const LIST_PATHS: Record<string, string> = {
  futures: `${ORIGIN}/uapi/v1/copy/v2/trader/list`,
  spot: `${ORIGIN}/sapi/v1/spot_copy/trader/list`,
}
/** Canonical TF → Blofin range_time token. */
const RANGE_TIME: Record<number, string> = { 7: '1', 30: '2', 90: '3' }
/** Canonical TF → profile stat_period token (distinct from board range_time). */
const STAT_PERIOD: Record<number, string> = { 7: 'D7', 30: 'D30', 90: 'D90' }
const PROFILE_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  'x-requested-with': 'XMLHttpRequest',
  'x-tz': 'UTC',
}
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
    // Profile harvested (headful capture 2026-07-02): stat/indicators (sharpe/
    // sortino/calmar/volatility — NOT on board) + symbol_performance (prefs) +
    // performance (chart). Records surfaces still gated (see header GAPS).
    profile: true,
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

  /**
   * Per-trader profile: 3 unsigned stat endpoints + info (headful-discovered
   * 2026-07-02). One composite payload → parseBlofinProfile. Board-only fields
   * (roi/pnl/mdd/aum) come from the leaderboard crawl; these ADD sharpe/sortino/
   * calmar/volatility/annualized_roi/trading-preferences/chart.
   */
  async getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle> {
    const fetcher = apiFetcher(await session.api())
    const tf = (timeframe === 0 ? 90 : timeframe) as RankingTimeframe
    const stat = STAT_PERIOD[tf] ?? 'D30'
    const uid = exchangeTraderId
    const post = (path: string, body: Record<string, unknown>) =>
      replayJson(session, fetcher, {
        url: `${ORIGIN}/uapi/v1/copy/${path}`,
        method: 'POST',
        headers: PROFILE_HEADERS,
        body,
      }).catch(() => null) // one dead endpoint never sinks the whole profile

    const [info, indicators, symbolPerf, performance] = await Promise.all([
      post('trader/info', { uid }),
      post('trader/stat/indicators', { uid, stat_period: stat }),
      post('trader/stat/symbol_performance', { uid, stat_period: stat, type: 'all' }),
      post('trader/stat/performance', { uid, stat_period: stat, type: 'all' }),
    ])

    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { info, indicators, symbolPerf, performance, timeframe: tf },
          url: `${ORIGIN}/copy-trade/details/${uid}`,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },
  async getPositions(): Promise<RawBundle> {
    return { pages: [], fetchedAt: new Date().toISOString() }
  },
  async *getHistory(): AsyncIterable<RawPage> {
    return
  },

  parseLeaderboard: parseBlofinLeaderboardPage,
  parseLeaderboardSeries: parseBlofinLeaderboardSeries,
  parseProfile: parseBlofinProfile,
  parsePositions: (): ParsedPosition[] => [],
  parseHistory: (_raw: unknown, _kind: HistoryKind): ParsedHistoryRow[] => [],
}

registerAdapter(blofinAdapter)

export { blofinAdapter }
