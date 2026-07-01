/**
 * MEXC Futures copy-trading ("MEXC AI 大模型跟单交易竞技") pure parsers —
 * spec §7 #10 / §11.6. Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-11): roi / winRate /
 * maxDrawdown are plain FRACTIONS (4.313 = 431.3%, 0.7142 = 71.42%) — we
 * store percent, matching the Bitget/Bybit adapters. PnL/funds are plain
 * USDT numbers. Timestamps are ms epochs (UTC).
 *
 * Composite payload shapes (built by the adapter, replayable from RAW):
 *   leaderboard page: { list: <traders/v2 resp>, aiUids: string[] }
 *   AI-tab page:      { aiDetail: <traders/aiDetail resp>, aiUids: string[] }
 *   profile bundle:   { trader, accumulate, dayPnl, ability, hold,
 *                       contractStat, timeframe }
 * AI 交易员 marking (spec §1.3): trader_kind='bot', bot_strategy='ai' when
 * the uid is in the AI-tab roster (traders/ai) OR the row itself carries
 * traderType='AI' (both signals observed live; the roster is authoritative
 * since most AI-tab rows report traderType='NORMAL').
 */

import { createHash } from 'crypto'
import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
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

/** Fraction → percent without float dust (0.7142 → 71.42, 4.313 → 431.3). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

function iso(msEpoch: unknown): string | null {
  const n = num(msEpoch)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

function data(payload: unknown): Dict | null {
  const d = (payload as Dict)?.data
  return d && typeof d === 'object' ? (d as Dict) : null
}

/** MEXC futures positionType: 1 = long, 2 = short. */
function side(v: unknown): 'long' | 'short' | null {
  const n = int(v)
  if (n === 1) return 'long'
  if (n === 2) return 'short'
  return null
}

interface LeaderboardComposite {
  list?: unknown
  aiDetail?: unknown
  aiUids?: string[]
}

function cardRow(
  item: Dict,
  positionalRank: number,
  aiUids: ReadonlySet<string>,
  forceAi: boolean
): ParsedLeaderboardRow | null {
  const uid = item.uid
  if (!uid) return null
  const isAi = forceAi || aiUids.has(String(uid)) || item.traderType === 'AI'
  return {
    exchangeTraderId: String(uid),
    // Positional in-page rank; re-anchored across pages by the caller.
    rank: positionalRank,
    nickname: (item.nickname as string) ?? null,
    avatarUrlOrigin: (item.avatar as string) ?? null,
    walletAddress: null,
    traderKind: isAi ? 'bot' : 'human',
    botStrategy: isAi ? 'ai' : null,
    headlineRoi: pct(item.roi),
    headlinePnl: num(item.pnl),
    headlineWinRate: pct(item.winRate),
    // Board (7d-only) carries the 7d MDD (maxDrawdown7, fraction→pct) and AUM
    // (followCopyFunds 带单规模, absolute USD) — were raw-only. Profile already
    // captures these ~99%, so this just broadens board-only/un-enriched coverage.
    headlineMdd: pct(item.maxDrawdown7),
    headlineAum: num(item.followCopyFunds),
    traderMeta: isAi ? { trader_type: 'AI' } : null,
    // Style tags, sparkline arrays, contractRateList, matchRate, S-grade
    // inputs... kept verbatim (spec §12.2 Arena Score v2 features).
    raw: item,
  }
}

/**
 * 全部交易员 board (GET traders/v2?condition=[]&limit&orderBy&page, verified
 * 2026-06-11) wrapped as { list, aiUids }; the separately-crawled AI 交易员
 * tab (GET traders/aiDetail?interval&uids) arrives as { aiDetail, aiUids }.
 * Cross-page duplicates (an AI trader also on the main board) collapse in
 * staging dedupe, which keeps the better-ranked row — both row shapes carry
 * the bot marking so neither direction loses it.
 */
export function parseMexcLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const composite = (raw ?? {}) as LeaderboardComposite
  const aiUids = new Set((composite.aiUids ?? []).map(String))

  let items: Dict[] = []
  let reportedTotal: number | null = null
  // Rows from the AI-tab page are bot/ai UNCONDITIONALLY: aiDetail returns
  // the full competition set while the traders/ai roster only lists the
  // currently-enabled agents (live divergence observed 2026-06-11 — 16
  // aiDetail rows vs 10 roster uids). The roster only widens marking for
  // main-board rows.
  const forceAi = composite.aiDetail !== undefined
  if (forceAi) {
    const d = data(composite.aiDetail)
    items = Array.isArray(d?.traders) ? (d.traders as Dict[]) : []
  } else {
    const d = data(composite.list)
    items = Array.isArray(d?.content) ? (d.content as Dict[]) : []
    reportedTotal = int(d?.total)
  }

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const row = cardRow(items[i], i + 1, aiUids, forceAi)
    if (row) rows.push(row)
  }
  return { rows, reportedTotal }
}

const TF_LABEL: Record<string, Timeframe> = {
  SEVEN_DAYS: 7,
  THIRTY_DAYS: 30,
  NINETY_DAYS: 90,
}

export { TF_LABEL as MEXC_TF_LABEL }

interface ProfileBundle {
  trader?: unknown
  accumulate?: unknown
  dayPnl?: unknown
  ability?: unknown
  hold?: unknown
  contractStat?: unknown
  timeframe?: number
}

/** {time[], pnl[], roi[]} arrays → aligned series points. */
function arrayPoints(
  d: Dict | null,
  valueKey: 'pnl' | 'roi',
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  const times = Array.isArray(d?.time) ? (d.time as unknown[]) : []
  const values = Array.isArray(d?.[valueKey]) ? (d[valueKey] as unknown[]) : []
  const points: Array<{ ts: string; value: number }> = []
  for (let i = 0; i < Math.min(times.length, values.length); i++) {
    const ts = iso(times[i])
    const value = decode(values[i])
    if (ts === null || value === null) continue
    points.push({ ts, value })
  }
  return points
}

/**
 * Profile bundle, one per TF (spec §11.6 带单表现 + 累计收益 dual chart):
 *   trader:       GET trader?intervalType=...&uid=   → per-TF stats block
 *   accumulate:   GET trader/statAccumulate?dataType=ACCUMULATE_PNL_ROI
 *   dayPnl:       GET trader/statAccumulate?dataType=DAY_PNL
 *   ability:      GET trader/abilityRating?intervalType=...  → 能力分析
 *                 radar percentile scores + S/A/B grade (spec §12.2/§12.3)
 *   hold:         GET trader/holdStats?dataType=ORDER&interval=... → 持仓时长
 *   contractStat: GET trader/contract/stat?statsIntervalType=... → 合约偏好
 */
export function parseMexcProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 90) as Timeframe
  const t = data(bundle.trader)
  const ability = data(bundle.ability)
  const hold = data(bundle.hold)
  const contracts = (bundle.contractStat as Dict)?.data
  const accum = data(bundle.accumulate)
  const daily = data(bundle.dayPnl)

  const stats: ParsedStats[] = []
  if (t) {
    const extras: Record<string, unknown> = {}
    if (ability) {
      // Percentile scores are 0-1 fractions ("位于前 +99.38%" renders from
      // these); rating is the letter grade (S/A+/...).
      extras.ability_rating = ability.rating ?? null
      extras.ability_scores = {
        profit: num(ability.profitScore),
        win_rate: num(ability.winRateScore),
        win_times: num(ability.winTimesScore),
        single_max_profit: num(ability.singleMaxProfitScore),
        max_winning_times: num(ability.maxWinningTimesScore),
      }
    }
    if (Array.isArray(t.tags)) {
      extras.style_tags = (t.tags as Dict[]).map((tag) => ({
        code: tag.code ?? null,
        content: tag.content ?? null,
      }))
    }
    if (t.tradeFrequency !== undefined) extras.trade_frequency_per_week = num(t.tradeFrequency)
    const lastTrade = iso(t.lastTradeTime)
    if (lastTrade) extras.last_trade_time = lastTrade
    if (t.settledDay !== undefined) extras.settled_days = int(t.settledDay)
    if (t.equity !== undefined) extras.total_equity = num(t.equity)
    if (t.avgOrderAmount !== undefined) extras.avg_order_amount = num(t.avgOrderAmount)
    if (t.totalRoi !== undefined) extras.total_roi = pct(t.totalRoi)
    if (t.totalPnl !== undefined) extras.total_pnl = num(t.totalPnl)
    if (t.totalWinRate !== undefined) extras.total_win_rate = pct(t.totalWinRate)
    // 盈亏比 comes as a display string like "4.0:1" — parse to a finite ratio so
    // promoteExtrasMetrics can surface it (a bare string never Number()s → the
    // pnl_ratio metric silently never displayed). Phase A fix.
    if (typeof t.profitAndLossRatio === 'string' && t.profitAndLossRatio.includes(':')) {
      const [a, b] = t.profitAndLossRatio.split(':').map((x) => Number(x))
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
        extras.profit_and_loss_ratio = Math.round((a / b) * 100) / 100
      }
    } else if (t.profitAndLossRatio !== undefined) {
      const plr = num(t.profitAndLossRatio)
      if (plr !== null) extras.profit_and_loss_ratio = plr
    }
    if (t.lossTimes !== undefined) extras.loss_trades = int(t.lossTimes) // 亏损次数 (逐图核对)
    if (t.totalFollowers !== undefined) extras.copier_count_history = int(t.totalFollowers)
    if (t.interestedNum !== undefined) extras.interested_count = int(t.interestedNum)
    if (t.traderType === 'AI') extras.trader_type = 'AI'
    const maxHoldSecs = num(hold?.maxHoldTime)
    if (maxHoldSecs !== null) extras.max_hold_time_hours = maxHoldSecs / 3600
    if (Array.isArray(hold?.holdDetailList)) extras.hold_histogram = hold.holdDetailList

    const avgHoldSecs = num(hold?.avgHoldTime)
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(t.roi),
      pnl: num(t.pnl),
      sharpe: null,
      mdd: pct(t.maxDrawdown),
      winRate: pct(t.winRate),
      winPositions: int(t.winTimes),
      totalPositions: int(t.openTimes),
      copierPnl: num(t.followProfit),
      copierCount: int(t.followers),
      aum: num(t.followCopyFunds), // 带单规模
      volume: null,
      // profitRatio 0.1 → 10% (stored as percent, Bitget convention)
      profitShareRate: pct(t.profitRatio),
      holdingDurationAvgHours: avgHoldSecs === null ? null : avgHoldSecs / 3600,
      tradingPreferences: Array.isArray(contracts) ? { contracts } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = arrayPoints(accum, 'roi', pct) // 累计收益率 (%)
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = arrayPoints(accum, 'pnl', num) // 累计收益 (USDT)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })
  const dailyPnl = arrayPoints(daily, 'pnl', num) // 每日交易表现 bars
  if (dailyPnl.length > 0) series.push({ timeframe: tf, metric: 'pnl_daily', points: dailyPnl })

  return {
    stats,
    series,
    nickname: t ? ((t.nickname as string) ?? null) : null,
    avatarUrlOrigin: t ? ((t.avatar as string) ?? null) : null,
  }
}

/**
 * 当前带单 (GET trader/orders/v2?orderListType=ORDER, verified 2026-06-11):
 * open lead orders. amount = contracts qty, margin/leverage exposed;
 * unrealized PnL is NOT public here → NULL (NULL-collapse, spec §6).
 */
export function parseMexcPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const d = data(raw)
  const list = Array.isArray(d?.content) ? (d.content as Dict[]) : []
  const out: ParsedPosition[] = []
  for (const item of list) {
    if (!item.symbol) continue
    out.push({
      symbol: String(item.symbol),
      side: side(item.positionType),
      leverage: num(item.leverage),
      size: num(item.amount),
      entryPrice: num(item.openAvgPrice),
      markPrice: null,
      unrealizedPnl: null,
      raw: item,
    })
  }
  return out
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/**
 * 历史带单 (GET trader/ordersHis/v2, verified 2026-06-11): closed lead
 * orders, newest first; orderId is the stable natural key. released =
 * realized PnL. 90-day public retention (GET historyDays).
 */
export function parseMexcPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.content) ? (d.content as Dict[]) : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    if (!item.symbol) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.openTime),
      closedAt: iso(item.closeTime),
      symbol: String(item.symbol),
      side: side(item.positionType),
      leverage: num(item.leverage),
      size: num(item.amount),
      entryPrice: num(item.openAvgPrice),
      exitPrice: num(item.closeAvgPrice),
      realizedPnl: num(item.released),
      dedupeHash: item.orderId
        ? dedupeHash('mexc_ph', item.orderId)
        : dedupeHash('mexc_ph', item.symbol, item.openTime, item.closeTime, item.amount),
      raw: item,
    })
  }
  return out
}

/**
 * 跟随者 (GET trader/followers/v2, verified 2026-06-11). nickname is a
 * partially-masked email — stored for dedupe/aggregates only, NEVER
 * rendered (spec §6 copier PII). No row timestamp → ts = ctx.scrapedAt.
 */
export function parseMexcCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.content) ? (d.content as Dict[]) : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const uid = item.followerUid
    if (!uid) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String((item.nickname as string) ?? uid),
      copierPnl: num(item.copyProfit),
      copierInvested: num(item.copyFunds),
      copyDurationDays: null, // not exposed by this endpoint
      dedupeHash: dedupeHash('mexc_cp', uid, item.copyFunds, item.copyProfit),
      raw: item,
    })
  }
  return out
}

export function parseMexcHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseMexcPositionHistory(raw, ctx)
    case 'copiers':
      return parseMexcCopiers(raw, ctx)
    default:
      // orders (sub-order level) and transfers are not exposed publicly.
      throw new Error(`[mexc] history surface ${kind} not supported`)
  }
}
