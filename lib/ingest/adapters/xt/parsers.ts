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

import { createHash } from 'crypto'
import type {
  BoardSeriesBlock,
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
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

/** Board-row copier/tenure/growth fields → trader_stats.extras (逐图核对). */
function xtBoardExtras(item: Dict): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const copierPnl = num(item.totalFollowerProfit)
  if (copierPnl !== null) ext.copier_total_profit = copierPnl
  const tradeDays = int(item.tradeDays ?? item.days)
  if (tradeDays !== null) ext.trading_days = tradeDays
  const growth = int(item.newFollowNumber)
  if (growth !== null) ext.copier_growth = growth
  const followerMargin = num(item.followerMargin)
  if (followerMargin !== null) ext.follower_margin = followerMargin
  return Object.keys(ext).length > 0 ? ext : null
}
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
      // Lead AUM = total follower margin under management (img63 "Lead AUM").
      headlineAum: num(item.totalFollowerMargin),
      // 逐图核对 image63/65: the board row (24 keys) carries copier profit /
      // tenure / growth that the thin leader-detail-v2 profile lacks. Promote them.
      headlineExtras: xtBoardExtras(item),
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
 *
 * XT has also returned a corrupt prefix from a different date range (for
 * example nine October 2025 points before an otherwise valid Apr–Jul 2026
 * 90-day chart). Anchor the inclusive calendar window to the UTC day that
 * contains ctx.scrapedAt: a 90d chart may contain that day plus the preceding
 * 89 UTC days. Do not slice to N points — a sparse upstream chart must remain
 * sparse rather than looking complete. A point may be at most five minutes
 * after the exact scrape time to tolerate small exchange/worker clock skew;
 * anything later is future data and is rejected.
 *
 * Duplicate exact millisecond timestamps use the last value in the upstream
 * payload, then the remaining points are sorted chronologically.
 */
const XT_SERIES_DAY_MS = 86_400_000
const XT_SERIES_FUTURE_SKEW_MS = 5 * 60_000

export function parseXtLeaderboardSeries(
  payload: unknown,
  ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  const scrapedAtMs = Date.parse(ctx.scrapedAt)
  if (!Number.isFinite(scrapedAtMs)) return out

  const scrapedAtUtcDayMs = Math.floor(scrapedAtMs / XT_SERIES_DAY_MS) * XT_SERIES_DAY_MS
  const windowStartMs = scrapedAtUtcDayMs - (timeframe - 1) * XT_SERIES_DAY_MS
  const latestAllowedMs = scrapedAtMs + XT_SERIES_FUTURE_SKEW_MS

  for (const item of items(payload)) {
    const id = item.accountId
    if (id === null || id === undefined) continue
    const chart = Array.isArray(item.chart) ? (item.chart as Dict[]) : []
    const byTimestamp = new Map<number, number>()
    for (const point of chart) {
      const t = num(point.time)
      const value = num(point.amount)
      if (
        t === null ||
        !Number.isSafeInteger(t) ||
        value === null ||
        t < windowStartMs ||
        t > latestAllowedMs
      ) {
        continue
      }
      byTimestamp.set(t, value)
    }
    const points = [...byTimestamp]
      .sort(([a], [b]) => a - b)
      .map(([t, value]) => ({ ts: new Date(t).toISOString(), value }))
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
  const bundle = (raw ?? {}) as {
    detail?: Dict
    stats?: Dict
    symbolPrefer?: Dict
    timeframe?: number
  }
  const tf = (num(bundle.timeframe) ?? 90) as Timeframe
  const info = ((bundle.detail as Dict)?.result ?? null) as Dict | null
  // leader-stats = the full per-TF Performance block (live-captured 2026-07-01).
  const perf = ((bundle.stats as Dict)?.result ?? null) as Dict | null
  const prefRows = bundle.symbolPrefer?.result ?? null

  const stats: ParsedStats[] = []
  if (info || perf) {
    const extras: Record<string, unknown> = {}
    if (info && typeof info.intro === 'string' && info.intro.length > 0) extras.intro = info.intro
    if (info?.leadDays !== undefined) extras.leading_days = int(info.leadDays)
    if (info?.platformProfitRate !== undefined)
      extras.platform_profit_rate = pct(info.platformProfitRate)
    if (info && typeof info.levelName === 'string') extras.level_name = info.levelName
    const tags = labelTags(info?.label)
    if (tags) extras.style_labels = tags
    if (info?.followNumber !== undefined) extras.copier_count_history = int(info.followNumber)
    if (info?.maxFollowerSize !== undefined) extras.max_copier_slots = int(info.maxFollowerSize)
    // ── Performance block (leader-stats) — the img65 fields ──
    if (perf) {
      const avgProfit = num(perf.avgProfitAmount)
      if (avgProfit !== null) extras.avg_profit = avgProfit
      const avgLoss = num(perf.avgLossAmount)
      if (avgLoss !== null) extras.avg_loss = avgLoss
      const plr = num(perf.pnlRate) // "--" → null
      if (plr !== null) extras.pnl_ratio = plr
      const freq = num(perf.tradeFrequency)
      if (freq !== null) extras.trade_frequency = freq
      const tradeDays = int(perf.tradeDays)
      if (tradeDays !== null) extras.trading_days = tradeDays
      const lossCount = int(perf.lossCount)
      if (lossCount !== null) extras.loss_trades = lossCount
      const totalEarnings = num(perf.totalEarnings)
      if (totalEarnings !== null) extras.total_pnl = totalEarnings
    }

    const holdSecs = perf ? num(perf.avgHoldTime) : null

    stats.push({
      timeframe: tf,
      // leader-stats has no data-updated ts; detail-v2 none either.
      asOf: ctx.scrapedAt,
      // Prefer the per-TF Performance ROI (recentRate, decimal→pct); fall back to
      // the overview overall profitRate.
      roi: perf ? pct(perf.recentRate) : pct(info?.profitRate),
      pnl: perf ? num(perf.totalEarnings) : null,
      sharpe: null, // XT exposes no Sharpe on any endpoint
      mdd: perf ? pct(perf.maxRetraction) : null,
      winRate: perf ? pct(perf.winRate) : null,
      winPositions: perf ? int(perf.profitCount) : null,
      totalPositions: perf ? int(perf.totalTransactions) : null,
      copierPnl: perf ? num(perf.followersEarnings) : null,
      copierCount: int(info?.currentFollowNumber),
      // Lead AUM = follower margin under management (per-TF) — falls back to 总权益.
      aum: perf ? num(perf.followerMargin) : num(info?.totalRights),
      volume: null, // daily volume series available separately if needed
      profitShareRate: null,
      holdingDurationAvgHours: holdSecs === null ? null : Math.round((holdSecs / 3600) * 100) / 100,
      tradingPreferences: xtSymbolPrefer(prefRows),
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

/** leader-symbol-prefer rows → 市场偏好 (symbol / count / percentage / pnl). */
function xtSymbolPrefer(rows: unknown): Record<string, unknown> | null {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const markets = rows
    .map((r) => {
      const d = r as Dict
      const symbol = typeof d.symbol === 'string' ? d.symbol.toUpperCase() : null
      if (!symbol) return null
      return { symbol, count: int(d.count), percentage: num(d.percentage), pnl: num(d.pnl) }
    })
    .filter(Boolean)
  return markets.length > 0 ? { markets } : null
}

// ── Record surfaces (public direct-API, discovered 2026-07-02) ───────────────
// GET {base}/leader-order-history?leaderAccountId={id}&page&size → closed
// positions (open/close time+price, side, leverage, realizedPnl, profitRate).
// Envelope: {returnCode, result:{hasPrev, hasNext, items[]}}. Unsigned, public
// (same host as the profile endpoints) — no browser/sign needed. Rows are
// round-trip closed positions → position_history (not order-level).

/** Stable natural identity for idempotent record upserts (spec §2.3). */
function xtDedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/** ms epoch → ISO, or null. */
function isoMs(v: unknown): string | null {
  const n = num(v)
  if (n === null || n <= 0) return null
  return new Date(n).toISOString()
}

/** eth_usdt → ETH-USDT (align with the board symbol shape). */
function normalizeSymbol(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  return v.toUpperCase().replace(/_/g, '-')
}

export function parseXtHistory(raw: unknown, kind: HistoryKind, ctx: ParseCtx): ParsedHistoryRow[] {
  const rows = ((raw as Dict)?.result as Dict | undefined)?.items
  const list = Array.isArray(rows) ? (rows as Dict[]) : []

  if (kind === 'position_history') {
    const out: ParsedHistoryRow[] = []
    for (const r of list) {
      const symbol = normalizeSymbol(r.symbolName)
      if (!symbol) continue
      out.push({
        kind: 'position_history',
        openedAt: isoMs(r.openTime),
        closedAt: isoMs(r.closeTime) ?? ctx.scrapedAt,
        symbol,
        side: typeof r.positionSide === 'string' ? r.positionSide : null,
        leverage: num(r.openLeverage),
        size: num(r.positionSize ?? r.openSize ?? r.closeSize),
        entryPrice: num(r.openPrice ?? r.entryPrice),
        exitPrice: num(r.closePrice),
        realizedPnl: num(r.realizedPnl),
        dedupeHash: xtDedupeHash('xt_ph', r.id ?? r.orderId, r.openTime),
        raw: r,
      })
    }
    return out
  }

  if (kind === 'copiers') {
    // leader-follower-page → copiers. followerName is PII → stored for dedupe/
    // aggregation only; the render path emits aggregates (spec §6).
    const out: ParsedHistoryRow[] = []
    for (const c of list) {
      const label = typeof c.followerName === 'string' ? c.followerName : null
      out.push({
        kind: 'copiers',
        ts: ctx.scrapedAt,
        copierLabel: label,
        copierPnl: num(c.followProfitU),
        copierInvested: num(c.followMarginU ?? c.followAmountTotal),
        copyDurationDays: int(c.days),
        dedupeHash: xtDedupeHash('xt_cp', c.id ?? label),
        raw: c,
      })
    }
    return out
  }

  return [] // orders / transfers / current positions not exposed publicly
}
