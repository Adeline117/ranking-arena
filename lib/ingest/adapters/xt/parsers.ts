/**
 * XT pure parsers (spec §11.13) — work on stored RAW payloads only
 * (re-parse guarantee, spec §5.5).
 *
 * One adapter serves xt_futures + xt_spot via src.meta.boardKey. The two
 * boards use the SAME endpoint name (`leader-list-v2`) under different API
 * bases and response envelopes:
 *   futures: /fapi/user/v1/public/copy-trade/* — envelope {returnCode, result}
 *   spot:    /sapi/v4/account/public/copy-trade/* — envelope {rc, mc, ma, result}
 * Both return result.{items, hasNext, hasPrev} with NO total (pagination is
 * hasNext + short-page; the spot degenerate-page rule handles §5.6).
 *
 * The board row is PER-TF (days=7|30|90) and rich: income (P&L), incomeRate
 * (ROI, decimal), winRate (decimal), maxRetraction (MDD, already percent),
 * followerProfit (copier PnL), followerCount, maxFollowerSize, label (style
 * tags), levelName (Lvl badge → traderMeta), and a cumulative-income `chart`
 * series kept verbatim in raw. leader-detail-v2 adds identity/overview
 * (intro, leadDays, profitRate — TF-independent).
 *
 * Verified by live capture 2026-06-11 (xt-*-debug scripts, deleted).
 */

import type {
  ParseCtx,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedProfile,
  ParsedStats,
  Timeframe,
} from '../../core/types'

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

/** XT ratios are decimal fractions (0.6461 = 64.61%). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

function items(payload: unknown): Dict[] {
  const result = (payload as Dict)?.result as Dict | undefined
  const list = result?.items
  return Array.isArray(list) ? (list as Dict[]) : []
}

function labelTags(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const tags = v.filter((t): t is string => typeof t === 'string' && t.length > 0)
  return tags.length > 0 ? tags : null
}

/**
 * leader-list-v2 page → per-TF rows. maxRetraction is ALREADY a percent
 * (1.4925 = 1.49%) unlike the decimal income/win rates. The cumulative
 * `chart` series and the full row are preserved in raw (spec §3).
 */
export function parseXtLeaderboardPage(payload: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const rows: ParsedLeaderboardRow[] = []
  const list = items(payload)
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    // futures: accountId numeric; spot: accountId string + numeric aid.
    const id = item.accountId
    if (id === null || id === undefined) continue
    const traderMeta: Record<string, unknown> = {}
    if (item.level !== undefined) traderMeta.xt_level = int(item.level)
    if (typeof item.levelName === 'string') traderMeta.xt_level_name = item.levelName
    rows.push({
      exchangeTraderId: String(id),
      rank: i + 1, // sorted list; re-anchored across pages by the caller
      nickname: typeof item.nickName === 'string' ? item.nickName : null,
      avatarUrlOrigin: typeof item.avatar === 'string' ? item.avatar : null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.incomeRate),
      headlinePnl: num(item.income),
      headlineWinRate: pct(item.winRate),
      traderMeta: Object.keys(traderMeta).length > 0 ? traderMeta : null,
      raw: item,
    })
  }
  // No source-reported total — pagination is hasNext/short-page (+ degenerate
  // rule for spot). reportedTotal stays null.
  return { rows, reportedTotal: null }
}

/** All-zero degenerate row (XT spot failure mode, spec §5.6): income,
 *  incomeRate AND winRate are all 0 — a placeholder, not a real trader. */
export function isXtDegeneratePage(payload: unknown): boolean {
  const list = items(payload)
  if (list.length === 0) return false
  return list.every(
    (item) =>
      (num(item.income) ?? 0) === 0 &&
      (num(item.incomeRate) ?? 0) === 0 &&
      (num(item.winRate) ?? 0) === 0
  )
}

/**
 * leader-detail-v2 → profile overview block (TF-independent: profitRate does
 * not vary with days, verified 2026-06-11). The rich per-TF stats (MDD,
 * copier PnL, win rate) come from the per-TF board crawl into
 * leaderboard_entries; this block carries identity + overall enrichment
 * (intro, leadDays, follower counts, style labels).
 */
export function parseXtProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as { detail?: Dict; timeframe?: number }
  const tf = (num(bundle.timeframe) ?? 90) as Timeframe
  const info = ((bundle.detail as Dict)?.result ?? null) as Dict | null

  const stats: ParsedStats[] = []
  if (info) {
    const extras: Record<string, unknown> = {}
    if (typeof info.intro === 'string' && info.intro.length > 0) extras.intro = info.intro
    if (info.leadDays !== undefined) extras.leading_days = int(info.leadDays)
    if (info.platformProfitRate !== undefined)
      extras.platform_profit_rate = pct(info.platformProfitRate)
    if (typeof info.levelName === 'string') extras.level_name = info.levelName
    const tags = labelTags(info.label)
    if (tags) extras.style_labels = tags

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt, // detail-v2 exposes no data-updated timestamp
      roi: pct(info.profitRate), // overall ROI (not per-TF)
      pnl: null, // not exposed on the overview block
      sharpe: null,
      mdd: null,
      winRate: null,
      winPositions: null,
      totalPositions: null,
      copierPnl: null,
      copierCount: int(info.currentFollowNumber),
      aum: num(info.totalRights), // 总权益 (displayEquity gate respected upstream)
      volume: null,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras,
    })
  }

  return {
    stats,
    series: [],
    nickname: info && typeof info.nickName === 'string' ? info.nickName : null,
    avatarUrlOrigin: info && typeof info.avatar === 'string' ? info.avatar : null,
  }
}
