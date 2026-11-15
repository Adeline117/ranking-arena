/**
 * XT adapter (spec §11.13) — one adapter serves xt_futures + xt_spot via
 * src.meta.boardKey. Public unsigned JSON API (no signing, unlike BingX).
 *
 * Endpoints (verified by live capture 2026-06-11):
 *   futures board:  GET /fapi/user/v1/public/copy-trade/leader-list-v3
 *                     ?page&ps&days={7|30|90}&sortType=INCOME&sortDirection=DESC
 *                     — result.{total, items}; real page+ps pagination. ps up to
 *                     at least 1000 is honoured (probed 2026-11-15: total 1969 =
 *                     2 pages of ps=1000, 1969 distinct accountIds, page three
 *                     empty; a page-one re-read had the same set, reordered).
 *   spot board:     GET /sapi/v4/account/public/copy-trade/leader-list-v2
 *                     ?sortType=INCOME_RATE&days&sortDirection=DESC&limit
 *                     — `limit` returns the top-N (page/offset ignored); fetched
 *                     in ONE big-limit request, placeholders dropped by the parser.
 *                     No attempt-bound capture: the board cannot be proven
 *                     complete (see captureLeaderboard).
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
import { CopierPageCapReachedError } from '../../core/history-page-cap'
import { registerAdapter, type SourceAdapter } from '../../core/adapter'
import type { FetchSession } from '../../fetch/types'
import { apiFetcher, replayJson } from '../../fetch/capture'
import {
  captureReplayLeaderboard,
  collectionMeta,
  requireEnvelopeValue,
} from '../../fetch/replay-capture'
import {
  parseXtHistory,
  parseXtLeaderboardPage,
  parseXtLeaderboardSeries,
  parseXtProfile,
} from './parsers'

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

/** Futures page meta: rows before parser validation; board population as reported. */
const xtFuturesLeaderboardMeta = collectionMeta({
  label: 'xt',
  assertSuccess: requireEnvelopeValue('xt', ['returnCode'], [0]),
  list: ['result', 'items'],
  total: ['result', 'total'],
})

const xtAdapter: SourceAdapter = {
  slug: 'xt',
  capabilities: {
    profile: true,
    // position_history (leader-order-history) + copiers (leader-follower-page)
    // harvested from public unsigned endpoints (same host as profile). Current
    // open positions (leader-order-page) return empty publicly (80 traders
    // probed 2026-07-02) = login-gated → positions stays disabled.
    positions: false,
    positionHistory: true,
    orders: false,
    transfers: false,
    copiers: true,
  },

  async *listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage> {
    // Spot: a single big-limit fetch covers the small board; the API ignores
    // page/offset and pads the tail with all-zero placeholders (dropped by
    // the parser). No real pagination and no attempt-bound capture.
    if (boardKey(src) === 'spot') {
      const fetcher = apiFetcher(await session.api())
      const limit = Number(src.meta.spot_limit) || 200
      const url =
        `${base(src)}/leader-list-v2?sortType=INCOME_RATE&days=${timeframe}` +
        `&sortDirection=DESC&limit=${limit}&canFollow=false&nickName=&elite=false`
      const payload = await replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })
      yield { pageIndex: 1, payload, url, fetchedAt: new Date().toISOString() }
      return
    }

    const capture = await xtAdapter.captureLeaderboard!(session, src, timeframe)
    yield* capture.parsePages
  },

  /**
   * Futures board in total mode: page+ps pages (ps = sources.page_size) until
   * the accepted rows reach result.total.
   *
   * Spot has no attempt-bound capture. leader-list-v2 ignores page/offset;
   * limit=1000 returns the whole board (hasNext false) but 198 of its 201
   * rows were all-zero placeholder leaders (probed 2026-11-15) that the
   * parser drops by design (spec §5.6), so accepted rows can never equal the
   * upstream population and neither completeness mode can hold.
   */
  async captureLeaderboard(session, src, timeframe, options) {
    if (boardKey(src) === 'spot') {
      throw new Error(
        '[xt] spot board has no attempt-bound capture: its placeholder rows are dropped, so completeness cannot be proven'
      )
    }
    options?.signal?.throwIfAborted()
    const fetcher = apiFetcher(await session.api())
    options?.signal?.throwIfAborted()
    const ps = src.page_size ?? 1000
    const listUrl = `${base(src)}/leader-list-v3`
    return captureReplayLeaderboard(
      { session, fetcher, src, label: 'xt', signal: options?.signal },
      {
        buildRequest: (pageIndex) => ({
          url:
            `${listUrl}?page=${pageIndex}&ps=${ps}&sortType=INCOME&days=${timeframe}` +
            `&sortDirection=DESC&canFollow=false&nickName=&elite=false`,
          method: 'GET',
          headers: HEADERS,
        }),
        publicRequest: {
          query: [
            'page',
            'ps',
            'sortType',
            'days',
            'sortDirection',
            'canFollow',
            'nickName',
            'elite',
          ],
        },
        pageBinding: { location: 'query', key: 'page' },
        extractMeta: xtFuturesLeaderboardMeta,
        pageSize: ps,
      }
    )
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
    // leader-stats carries the FULL per-TF Performance block (discovered via live
    // capture 2026-07-01): recentRate/totalEarnings/maxRetraction/winRate/
    // profitCount/lossCount/avgProfit/avgLoss/avgHoldTime/tradeFrequency/
    // followerMargin/followersEarnings — the img65 fields the thin detail-v2 lacks.
    // leader-symbol-prefer = 市场偏好 donut (img64). recentDays = TF.
    const [stats, symbolPrefer] = await Promise.all([
      replayJson(session, fetcher, {
        url: `${base(src)}/leader-stats?accountId=${exchangeTraderId}&recentDays=${tf}`,
        method: 'GET',
        headers: HEADERS,
      }).catch(() => null),
      replayJson(session, fetcher, {
        url: `${base(src)}/leader-symbol-prefer?accountId=${exchangeTraderId}&recentDays=${tf}`,
        method: 'GET',
        headers: HEADERS,
      }).catch(() => null),
    ])
    const fetchedAt = new Date().toISOString()
    return {
      pages: [
        {
          pageIndex: 1,
          payload: { detail, stats, symbolPrefer, timeframe: tf },
          url: `${base(src)}/leader-detail-v2`,
          fetchedAt,
        },
      ],
      fetchedAt,
    }
  },

  async getPositions(): Promise<RawBundle> {
    return { pages: [], fetchedAt: new Date().toISOString() }
  },

  /**
   * Public unsigned record surfaces (`leaderAccountId` param, {result:{items,
   * hasNext}} envelope): position_history ← leader-order-history (closed
   * round-trips), copiers ← leader-follower-page. Paginate until !hasNext /
   * short page; position_history also stops on cursor overlap (closeTime).
   */
  async *getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage> {
    let endpointName: string
    if (kind === 'position_history') endpointName = 'leader-order-history'
    else if (kind === 'copiers') endpointName = 'leader-follower-page'
    else return // orders / transfers / current positions not exposed publicly

    const fetcher = apiFetcher(await session.api())
    const size = Number(src.meta.history_page_size) || 20
    const maxPages = Number(src.meta.history_max_pages ?? 10) || 10
    const cursorMs = cursor ? Date.parse(cursor) : NaN

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const url =
        `${base(src)}/${endpointName}?leaderAccountId=${exchangeTraderId}` +
        `&page=${pageNo}&size=${size}`
      const payload = await replayJson(session, fetcher, { url, method: 'GET', headers: HEADERS })
      const envelope = payload as Record<string, unknown> | null
      if (kind === 'copiers' && (envelope?.returnCode !== 0 || envelope?.error != null)) {
        // A business error is not an empty follower list.
        throw new Error(
          `[xt] copiers returned a non-success API envelope (returnCode=${String(envelope?.returnCode)})`
        )
      }
      const result = envelope?.result as Record<string, unknown> | undefined
      const rows = Array.isArray(result?.items) ? (result!.items as Record<string, unknown>[]) : []
      if (rows.length === 0) break

      yield { pageIndex: pageNo, payload, url, fetchedAt: new Date().toISOString() }

      // position_history: stop once this page's oldest close overlaps the cursor.
      if (kind === 'position_history' && !Number.isNaN(cursorMs)) {
        const oldest = Math.min(
          ...rows.map((r) => Number(r.closeTime)).filter((n) => Number.isFinite(n))
        )
        if (Number.isFinite(oldest) && oldest <= cursorMs) break
      }
      if (result?.hasNext === false || rows.length < size) break
      if (kind === 'copiers' && pageNo === maxPages) {
        throw new CopierPageCapReachedError(src.slug, maxPages)
      }
    }
  },

  parseLeaderboard: parseXtLeaderboardPage,
  parseLeaderboardSeries: parseXtLeaderboardSeries,
  parseProfile: parseXtProfile,
  parsePositions: (): ParsedPosition[] => [],
  parseHistory: parseXtHistory,
}

registerAdapter(xtAdapter)

export { xtAdapter }
