/**
 * Blofin pure parsers (spec §11.14) — work on stored RAW payloads only
 * (re-parse guarantee, spec §5.5).
 *
 * One adapter serves blofin_futures + blofin_spot via src.meta.boardKey. The
 * "All Traders" board is a POST endpoint that returns FULL per-TF stats per
 * trader plus a cumulative-ROI chart, so the leaderboard crawl alone covers
 * the per-TF profile-stats requirement (the dedicated profile page is a
 * click-guarded SPA route with no reachable per-uid JSON endpoint):
 *   futures: POST /uapi/v1/copy/v2/trader/list
 *   spot:    POST /sapi/v1/spot_copy/trader/list
 *   body: {sort_field:"roi", range_time:"1"|"2"|"3" (=7|30|90d), page_num,
 *          page_size, trading_bots_type:[], tag_list:[], ...}
 *   data: {trader_info[], page_total, pages, page_num, page_size, range_time}
 *
 * Row (decimals): roi, mdd; plus pnl, aum, sharpe_ratio, followers,
 * followers_max, verified, and chart_data.roi[{time(ms), data}] (per-TF
 * cumulative ROI series, kept verbatim in raw). The board exposes no
 * per-row bot flag — trader_kind defaults to human; the Trading Bots
 * dropdown (trading_bots_type filter) would need a separate tagging pass
 * (documented gap).
 *
 * Verified by live capture 2026-06-11 (blofin-*-debug scripts, deleted).
 */

import type { ParseCtx, ParsedLeaderboardPage, ParsedLeaderboardRow } from '../../core/types'

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

/** Blofin roi/mdd are decimal fractions (4.5583 = 455.83%). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

function traderInfo(payload: unknown): Dict[] {
  const data = (payload as Dict)?.data as Dict | undefined
  const list = data?.trader_info
  return Array.isArray(list) ? (list as Dict[]) : []
}

/**
 * trader/list page → per-TF rows. The full row (mdd, sharpe_ratio, aum,
 * followers, verified, chart_data) is preserved in raw (spec §3) — it is the
 * per-TF profile-stats substrate since no per-uid profile endpoint exists.
 */
export function parseBlofinLeaderboardPage(
  payload: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const rows: ParsedLeaderboardRow[] = []
  const list = traderInfo(payload)
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const id = item.uid
    if (id === null || id === undefined) continue
    rows.push({
      exchangeTraderId: String(id),
      rank: i + 1, // sorted list; re-anchored across pages by the caller
      nickname: typeof item.nick_name === 'string' ? item.nick_name : null,
      avatarUrlOrigin: typeof item.profile === 'string' ? item.profile : null,
      walletAddress: null,
      // No per-row bot flag (only the trading_bots_type FILTER distinguishes
      // them) — default human; bot tagging is a documented gap.
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.roi),
      headlinePnl: num(item.pnl),
      headlineWinRate: null, // not exposed on the board row
      raw: item,
    })
  }
  const total = int(((payload as Dict)?.data as Dict | undefined)?.page_total)
  return { rows, reportedTotal: total }
}
