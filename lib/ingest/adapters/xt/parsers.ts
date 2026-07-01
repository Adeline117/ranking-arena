/**
 * XT pure parsers (spec §11.13) — work on stored RAW payloads only
 * (re-parse guarantee, spec §5.5).
 *
 * One adapter serves xt_futures + xt_spot via src.meta.boardKey. The full
 * "All Traders" board (spec §11.13 "View All Traders") uses DIFFERENT
 * endpoints per board — the curated leader-list-v2 only ever returns the
 * featured top-10:
 *   futures: /fapi/user/v1/public/copy-trade/leader-list-v3
 *            ?page&ps&sortType=INCOME&days&sortDirection=DESC — result.{total,
 *            items}, real page+ps pagination (ps up to 100, total exposed).
 *   spot:    /sapi/v4/account/public/copy-trade/leader-list-v2
 *            ?sortType=INCOME_RATE&days&sortDirection=DESC&limit — `limit`
 *            returns the top-N (page/offset ignored) with all-zero placeholder
 *            rows padding the tail once real traders run out (spec §5.6); the
 *            adapter fetches a large limit once and the parser drops the
 *            placeholders.
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
  BoardSeriesBlock,
  ParseCtx,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedProfile,
  ParsedStats,
  RankingTimeframe,
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

/** All-zero placeholder row (XT spot tail padding, spec §5.6). */
function isPlaceholderRow(item: Dict): boolean {
  return (
    (num(item.income) ?? 0) === 0 &&
    (num(item.incomeRate) ?? 0) === 0 &&
    (num(item.winRate) ?? 0) === 0
  )
}

/**
 * leader-list page → per-TF rows. maxRetraction is ALREADY a percent
 * (1.4925 = 1.49%) unlike the decimal income/win rates. The cumulative
 * `chart` series and the full row are preserved in raw (spec §3).
 * v3 (futures) exposes result.total; v2 (spot) does not. Spot all-zero
 * placeholder rows are dropped so they never reach serving.
 */
export function parseXtLeaderboardPage(payload: unknown, ctx: ParseCtx): ParsedLeaderboardPage {
  const rows: ParsedLeaderboardRow[] = []
  const list = items(payload)
  const dropPlaceholders = ctx.meta?.boardKey === 'spot'
  let rank = 0
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (dropPlaceholders && isPlaceholderRow(item)) continue
    // futures: accountId numeric; spot: accountId string + numeric aid.
    const id = item.accountId
    if (id === null || id === undefined) continue
    rank += 1
    const traderMeta: Record<string, unknown> = {}
    if (item.level !== undefined) traderMeta.xt_level = int(item.level)
    if (typeof item.levelName === 'string') traderMeta.xt_level_name = item.levelName
    rows.push({
      exchangeTraderId: String(id),
      rank, // sorted list; re-anchored across pages by the caller
      nickname: typeof item.nickName === 'string' ? item.nickName : null,
      avatarUrlOrigin: typeof item.avatar === 'string' ? item.avatar : null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.incomeRate),
      headlinePnl: num(item.income),
      headlineWinRate: pct(item.winRate),
      // XT's board JSON carries the per-TF MDD as `maxRetraction` (already a
      // percent — 1.4925 = 1.49%; a value >1 can't be a decimal fraction since
      // MDD <= 100%), even though the UI listing hides it. Drop it onto headlineMdd
      // (the board is authoritative for XT) so the publish path writes it to
      // trader_stats.mdd — matching blofin/bingx (which capture MDD at 90%+). Was
      // previously unread, leaving XT at 0% MDD capture.
      headlineMdd: num(item.maxRetraction),
      // 跟单人数 on every board row — publish writes it to trader_stats.copier_count,
      // so even board-tier traders (never deep-crawled) show a copier count. Was
      // previously left in raw only. Phase A.
      headlineCopierCount: int(item.followerCount),
      traderMeta: Object.keys(traderMeta).length > 0 ? traderMeta : null,
      raw: item,
    })
  }
  // v3 (futures) reports result.total; v2 (spot) does not (→ null).
  const total = int(((payload as Dict)?.result as Dict | undefined)?.total)
  return { rows, reportedTotal: total }
}

/**
 * Board-level free series (spec §13.1): each board row embeds a cumulative-
 * income `chart` = {amount, time(ms)} for the board's TF (days=7|30|90), so
 * EVERY ranked trader gets a PnL chart with no extra fetch — and XT has NO
 * profile series at all (parseXtProfile returns series:[]), so this is the
 * sole series path for XT. The leading {amount:0, time:0} seed point is a
 * placeholder (epoch 0) and is dropped.
 */
export function parseXtLeaderboardSeries(
  payload: unknown,
  _ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  for (const item of items(payload)) {
    const id = item.accountId
    if (id === null || id === undefined) continue
    const chart = Array.isArray(item.chart) ? (item.chart as Dict[]) : []
    const points = chart
      .map((p) => ({ t: num(p.time), value: num(p.amount) }))
      .filter((p): p is { t: number; value: number } => p.t !== null && p.t > 0 && p.value !== null)
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ ts: new Date(p.t).toISOString(), value: p.value }))
    if (points.length > 0) out.set(String(id), [{ timeframe, metric: 'pnl', points }])
  }
  return out
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
