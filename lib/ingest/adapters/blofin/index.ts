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
 * Spot profile (public probe 2026-11-20 — the detail SPA route is
 *   /copy-trade/details/{uid}?module=spot; the /uapi/v1/copy endpoints above
 *   answer a spot uid with its FUTURES copy account, the spot account is):
 *     POST /sapi/v1/spot_copy/trader/info              {uid}
 *     POST /sapi/v1/spot_copy/trader/stat/indicators   {uid, stat_period}
 *          → same fields as futures minus the volume ones; max_drawdown is the
 *            PERIOD drawdown (equals the board row's mdd of that range)
 *     POST /sapi/v1/spot_copy/trader/stat/performance  {uid, stat_period, type:"all"}
 *          → {performance:{roi,pnl,max_drawdown,win_rate}, roi[], pnl[], symbols[]}
 *     (stat/symbol_performance answers code 401 on the spot route; the
 *      per-symbol table is inside stat/performance.)
 *
 * Records (positions/position_history/copiers) — the detail UI TABS are
 *   login-gated, but the underlying uapi endpoints are PUBLIC + unsigned (probe
 *   2026-07-02, overturning the earlier "hard limit" note):
 *     POST /uapi/v1/copy/trader/order/list    {uid} → current open positions
 *     POST /uapi/v1/copy/trader/order/history {uid} → closed position history
 *     POST /uapi/v1/copy/trader/copiers       {uid} → copiers (nick_name masked)
 *   Same lightweight replayJson POST as getProfile — no browser needed.
 *
 * GAPS (documented):
 *  - Orders/transfers surfaces: blofin has no distinct order-event or transfer
 *    record endpoint (order/list + order/history are position-level).
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
import { apiFetcher, replayJson } from '../../fetch/capture'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
import {
  parseBlofinHistory,
  parseBlofinLeaderboardPage,
  parseBlofinLeaderboardSeries,
  parseBlofinPositions,
  parseBlofinProfile,
} from './parsers'
import { BLOFIN_INDICATORS_PATH, BLOFIN_SPOT_INDICATORS_PATH } from './profile-capture-contract'

const ORIGIN = 'https://blofin.com'
const LIST_PATHS: Record<string, string> = {
  futures: `${ORIGIN}/uapi/v1/copy/v2/trader/list`,
  spot: `${ORIGIN}/sapi/v1/spot_copy/trader/list`,
}
/** Per-board profile route: endpoint prefix + the declared capture endpoint. */
const PROFILE_ROUTES: Record<'futures' | 'spot', { prefix: string; indicatorsPath: string }> = {
  futures: { prefix: '/uapi/v1/copy/', indicatorsPath: BLOFIN_INDICATORS_PATH },
  spot: { prefix: '/sapi/v1/spot_copy/', indicatorsPath: BLOFIN_SPOT_INDICATORS_PATH },
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

/** Upstream page meta: rows counted before parser validation; board population as reported. */
const blofinLeaderboardMeta = collectionMeta({
  label: 'blofin',
  assertSuccess: requireEnvelopeValue('blofin', ['code'], [200]),
  list: ['data', 'trader_info'],
  total: ['data', 'page_total'],
  pageCount: ['data', 'pages'],
})

const blofinAdapter: SourceAdapter = {
  slug: 'blofin',
  capabilities: {
    // Profile harvested (headful capture 2026-07-02): stat/indicators (sharpe/
    // sortino/calmar/volatility — NOT on board) + symbol_performance (prefs) +
    // performance (chart). Records (positions/position_history/copiers) via the
    // PUBLIC unsigned uapi endpoints (probe 2026-07-02 — the UI tabs are
    // login-gated but the APIs are open). No orders/transfers surface.
    profile: true,
    positions: true,
    positionHistory: true,
    orders: false,
    transfers: false,
    copiers: true,
  },

  async captureLeaderboard(session, src, timeframe, options) {
    options?.signal?.throwIfAborted()
    const fetcher = apiFetcher(await session.api())
    options?.signal?.throwIfAborted()
    const url = listUrl(src)
    const pageSize = src.page_size ?? 20
    const rangeTime = RANGE_TIME[timeframe] ?? '2'
    return captureReplayLeaderboard(
      { session, fetcher, src, label: 'blofin', signal: options?.signal },
      {
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
        publicRequest: {
          body: [
            'hide_full_portfolios',
            'sort_field',
            'range_time',
            'sort_order',
            'nick_name',
            'trading_bots_type',
            'tag_list',
            'page_num',
            'page_size',
            'pnl_lower',
            'pnl_upper',
            'copier_pnl_lower',
            'copier_pnl_upper',
          ],
        },
        pageBinding: { location: 'body', path: ['page_num'] },
        extractMeta: blofinLeaderboardMeta,
        pageSize,
      }
    )
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    const capture = await blofinAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
  },

  /**
   * Per-trader profile: 3 unsigned stat endpoints + info (headful-discovered
   * 2026-07-02). One composite payload → parseBlofinProfile. Board-only fields
   * (roi/pnl/mdd/aum) come from the leaderboard crawl; these ADD sharpe/sortino/
   * calmar/volatility/annualized_roi/trading-preferences/chart.
   *
   * Each board reads its own account: futures /uapi/v1/copy/trader/*, spot
   * /sapi/v1/spot_copy/trader/* (the futures route answers a spot uid with the
   * trader's futures copy account, which must never be stored as spot stats).
   * The spot route has no symbol_performance response; its stat/performance
   * carries the per-symbol table.
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
    const board = boardKey(src)
    const route = PROFILE_ROUTES[board]
    const post = (path: string, body: Record<string, unknown>) =>
      replayJson(session, fetcher, {
        url: `${ORIGIN}${route.prefix}${path}`,
        method: 'POST',
        headers: PROFILE_HEADERS,
        body,
      }).catch(() => null) // one dead endpoint never sinks the whole profile

    const [info, indicators, symbolPerf, performance] = await Promise.all([
      post('trader/info', { uid }),
      post('trader/stat/indicators', { uid, stat_period: stat }),
      board === 'spot'
        ? Promise.resolve(null)
        : post('trader/stat/symbol_performance', { uid, stat_period: stat, type: 'all' }),
      post('trader/stat/performance', { uid, stat_period: stat, type: 'all' }),
    ])

    const fetchedAt = new Date().toISOString()
    // The composite page is keyed by the stat request that supplies its
    // ParsedStats block: the declared profile-capture endpoint, with the POST
    // body's identity (uid, stat_period) as the URL query so the attempt's
    // request projection binds both (./profile-capture-contract.ts).
    const indicatorsUrl = new URL(`${ORIGIN}${route.indicatorsPath}`)
    indicatorsUrl.searchParams.set('uid', uid)
    indicatorsUrl.searchParams.set('stat_period', stat)
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { info, indicators, symbolPerf, performance, timeframe: tf },
          url: indicatorsUrl.toString(),
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },
  /** Current open positions — public unsigned POST trader/order/list {uid}
   *  (close_time==null rows; the parser drops closed ones). */
  async getPositions(
    session: FetchSession,
    _src: SourceRow,
    exchangeTraderId: string
  ): Promise<RawBundle> {
    const fetcher = apiFetcher(await session.api())
    const fetchedAt = new Date().toISOString()
    const url = `${ORIGIN}/uapi/v1/copy/trader/order/list`
    const payload = await replayJson(session, fetcher, {
      url,
      method: 'POST',
      headers: PROFILE_HEADERS,
      body: { uid: exchangeTraderId, limit: 50, page: 1 },
    }).catch(() => null)
    if (payload === null) return { pages: [], fetchedAt }
    return { pages: [{ pageIndex: 1, payload, url, fetchedAt }], fetchedAt }
  },

  /** Closed-position history + copiers — public unsigned POST endpoints. First
   *  page suffices for the on-demand view (arena.* serves deeper pagination). */
  async *getHistory(
    session: FetchSession,
    _src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind
  ): AsyncIterable<RawPage> {
    let path: string
    if (kind === 'position_history') path = 'trader/order/history'
    else if (kind === 'copiers') path = 'trader/copiers'
    else return // orders / transfers not exposed
    const fetcher = apiFetcher(await session.api())
    const url = `${ORIGIN}/uapi/v1/copy/${path}`
    const payload = await replayJson(session, fetcher, {
      url,
      method: 'POST',
      headers: PROFILE_HEADERS,
      body: { uid: exchangeTraderId, limit: 50, page: 1 },
    }).catch(() => null)
    if (payload === null) return
    yield { pageIndex: 1, payload, url, fetchedAt: new Date().toISOString() }
  },

  parseLeaderboard: parseBlofinLeaderboardPage,
  parseLeaderboardSeries: parseBlofinLeaderboardSeries,
  parseProfile: parseBlofinProfile,
  parsePositions: parseBlofinPositions,
  parseHistory: parseBlofinHistory,
}

registerAdapter(blofinAdapter)

export { blofinAdapter }
