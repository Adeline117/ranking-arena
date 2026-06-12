/**
 * XT adapter (spec §11.13) — one adapter serves xt_futures + xt_spot via
 * src.meta.boardKey. Public unsigned JSON API (no signing, unlike BingX).
 *
 * Endpoints (verified by live capture 2026-06-11):
 *   futures board:  GET /fapi/user/v1/public/copy-trade/leader-list-v2
 *                     ?page&size&days={7|30|90}&sotType=INCOME_RATE
 *   spot board:     GET /sapi/v4/account/public/copy-trade/leader-list-v2 (same params)
 *   profile (both): GET .../leader-detail-v2?accountId — identity + overview
 *
 * The "View All Traders" link (spec §11.13) is just the SPA route to this
 * paginated leader-list-v2 endpoint — we hit it directly, so the truncation
 * footgun never applies. Page size is server-capped at 10 regardless of the
 * requested size; pagination is hasNext + short-page. XT spot returns
 * all-zero placeholder pages after the real traders run out (~3 pages, spec
 * §5.6) → the degenerate-page stop rule (meta.degenerate_page_stop) handles it.
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
import { isXtDegeneratePage, parseXtLeaderboardPage, parseXtProfile } from './parsers'

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
    const pageSize = src.page_size ?? 10
    const listUrl = `${base(src)}/leader-list-v2`
    const maxPages = Number(src.meta.max_pages) || null
    // Spec §5.6: the spot board emits all-zero placeholder pages once real
    // traders run out — stop after N consecutive degenerate pages.
    const degenerateStopAfter = Number(src.meta.degenerate_page_stop) || 1

    let pagesYielded = 0
    for await (const page of replayPaged({
      session,
      fetcher,
      buildRequest: (pageIndex) => ({
        url: `${listUrl}?page=${pageIndex}&size=${pageSize}&days=${timeframe}&sotType=INCOME_RATE`,
        method: 'GET',
        headers: HEADERS,
      }),
      extractMeta: (payload) => {
        const parsed = parseXtLeaderboardPage(payload, {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt: new Date().toISOString(),
          meta: src.meta,
        })
        return { rowCount: parsed.rows.length, reportedTotal: parsed.reportedTotal }
      },
      pageSize,
      isDegenerate: boardKey(src) === 'spot' ? isXtDegeneratePage : undefined,
      degenerateStopAfter,
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
  parseProfile: parseXtProfile,
  parsePositions: (): ParsedPosition[] => [],
  parseHistory: (_raw: unknown, _kind: HistoryKind): ParsedHistoryRow[] => [],
}

registerAdapter(xtAdapter)

export { xtAdapter }
