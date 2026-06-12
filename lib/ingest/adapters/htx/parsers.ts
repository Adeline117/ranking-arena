/**
 * HTX Spot & Futures copy-trading pure parsers — spec §7 #13/#14 / §11.9.
 * One parser set serves both boards (src.meta.boardKey) — payload shapes are
 * identical (verified live 2026-06-11). Currency is USDT.
 *
 * Number conventions (verified by live capture 2026-06-11): numerics are
 * STRINGS; rates (profitRate90 / winRate / mdd / takeRate /
 * totalProfitRate) are plain fractions ("1.8578" = 185.78%) — we store
 * percent, matching the other adapters. Timestamps are MS epochs (UTC).
 *
 * Endpoint payload shapes (base futures.htx.com/-/x/hbg/v1/{board}/copytrading):
 *   leaderboard: GET rank?rankType=1&pageNo=N&pageSize≤50
 *                → { data: { totalNum, itemList: [card...] } }
 *                rankType 1 = PnL(%) sort exposing the FULL population
 *                (rankType 0 "Leaderboard" chip is a curated subset — the
 *                survey's 60/24 counts came from that subset).
 *   profile bundle (composite, built by the adapter, replayable from RAW):
 *     { baseInfo, performance, profitRateChart, profitChart, timeframe }
 *     - trader-info/trader-base-info?userSign=     identity + bio + tags
 *     - trader-info/trader-performance?userSign=   Overview block — ALL-TIME
 *       semantics (period param IGNORED, verified); spec §11.9 "Total PnL"
 *     - trader-info/trader-profit-rate-chart?userSign&period  PnL(%) chart
 *     - trader-info/trader-profit-chart?userSign&period       daily PnL bars
 *       period: 0=24h, 1=7d, 2=30d, 3=90d
 *   positions:   GET trader-info/current-positions?userSign=
 *   history:     GET trader-info/history-positions?userSign&pageNo&pageSize
 *   copiers:     NOT public (login-gated; guesses 500) — capability off.
 *
 * Identity: exchange_trader_id = uid (stable numeric); userSign (the
 * base64-ish profile routing key) rides in traderMeta.user_sign — all
 * trader-info endpoints are keyed by it.
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

/** Fraction → percent without float dust ("1.8578" → 185.78). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

/** HTX epochs are MILLISECONDS. */
function iso(msEpoch: unknown): string | null {
  const n = num(msEpoch)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

function data(payload: unknown): Dict | null {
  const d = (payload as Dict)?.data
  return d && typeof d === 'object' ? (d as Dict) : null
}

/** direction buy → long, sell → short (futures position semantics). */
function sideFromDirection(v: unknown): 'long' | 'short' | null {
  if (v === 'buy') return 'long'
  if (v === 'sell') return 'short'
  return null
}

export function parseHtxLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const d = data(raw)
  const items = Array.isArray(d?.itemList) ? (d.itemList as Dict[]) : []
  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.uid === null || item.uid === undefined) continue
    rows.push({
      exchangeTraderId: String(item.uid),
      rank: i + 1, // positional; re-anchored across pages by the processor
      nickname: (item.nickName as string) ?? null,
      avatarUrlOrigin: (item.imgUrl as string) ?? null,
      walletAddress: null,
      traderKind: 'human', // no bot product on these boards
      botStrategy: null,
      headlineRoi: pct(item.profitRate90),
      headlinePnl: num(item.profit90),
      headlineWinRate: pct(item.winRate),
      // userSign routes every trader-info profile endpoint (spec §1.4
      // durable routing fact — same pattern as Bitget portfolio_id).
      traderMeta: item.userSign ? { user_sign: String(item.userSign) } : null,
      // mdd, aum, copyProfit, copier slots, 30-point sparkline... verbatim
      raw: item,
    })
  }
  return { rows, reportedTotal: int(d?.totalNum) }
}

interface ProfileBundle {
  baseInfo?: unknown
  performance?: unknown
  profitRateChart?: unknown
  profitChart?: unknown
  timeframe?: number
}

/** {x:[ms...], y:["v"...]} chart → series points. */
function chartPoints(
  d: Dict | null,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  const xs = Array.isArray(d?.x) ? (d.x as unknown[]) : []
  const ys = Array.isArray(d?.y) ? (d.y as unknown[]) : []
  const points: Array<{ ts: string; value: number }> = []
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const ts = iso(xs[i])
    const value = decode(ys[i])
    if (ts === null || value === null) continue
    points.push({ ts, value })
  }
  return points
}

/** symbolRates is an array of JSON STRINGS: '{"r":"0.9716","s":"ETH-USDT"}'. */
function parseSymbolRates(v: unknown): Array<{ symbol: string; ratio: number | null }> | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: Array<{ symbol: string; ratio: number | null }> = []
  for (const entry of v) {
    try {
      const parsed = typeof entry === 'string' ? JSON.parse(entry) : entry
      if (parsed && typeof parsed === 'object' && (parsed as Dict).s) {
        out.push({ symbol: String((parsed as Dict).s), ratio: pct((parsed as Dict).r) })
      }
    } catch {
      // skip malformed entries — preferences are additive
    }
  }
  return out.length > 0 ? out : null
}

/**
 * Profile bundle. The Overview block (trader-performance) is ALL-TIME (the
 * period param is ignored — verified 2026-06-11); the TF-scoped truth lives
 * in the charts and the board headline columns. HTX boards are 90d-only so
 * in practice this lands on the 90d stats row.
 */
export function parseHtxProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 90) as Timeframe
  const base = data(bundle.baseInfo)
  const perf = data(bundle.performance)
  const rateChart = data(bundle.profitRateChart)
  const pnlChart = data(bundle.profitChart)

  const stats: ParsedStats[] = []
  if (perf) {
    const extras: Record<string, unknown> = {}
    extras.stats_scope = 'all_time' // Overview block semantics (see header)
    if (perf.totalCopyUserNum !== undefined) {
      extras.copier_count_history = int(perf.totalCopyUserNum)
    }
    if (perf.weekTradeNum !== undefined) extras.trade_frequency_per_week = num(perf.weekTradeNum)
    const lastTrade = iso(perf.lastTrade)
    if (lastTrade) extras.last_trade_time = lastTrade
    const firstSignUp = iso(perf.firstSignUp)
    if (firstSignUp) extras.lead_since = firstSignUp
    if (Array.isArray(perf.avgProfit)) extras.avg_profit = num(perf.avgProfit[0])
    if (Array.isArray(perf.avgLost)) extras.avg_loss = num(perf.avgLost[0])
    if (Array.isArray(perf.profitLost)) extras.profit_loss_ratio = num(perf.profitLost[0])
    if (base?.profile) extras.introduction = base.profile
    if (typeof base?.tagMappings === 'string' && base.tagMappings.length > 0) {
      extras.style_tags = (base.tagMappings as string).split(',')
    }
    if (base?.fullUserNum !== undefined) extras.max_copier_slots = int(base.fullUserNum)

    const winNum = int(perf.winNum)
    const lossNum = int(perf.lossNum)
    const avgHoldMs = num(perf.avgHoldTime)
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(perf.totalProfitRate),
      pnl: num(perf.totalProfit),
      sharpe: null,
      mdd: pct(perf.mdd),
      winRate: pct(perf.winRate),
      winPositions: winNum,
      totalPositions: winNum !== null && lossNum !== null ? winNum + lossNum : null,
      copierPnl: num(perf.copyTotalProfit),
      copierCount: int(perf.copyUserNum),
      aum: num(perf.aum),
      volume: null,
      profitShareRate: pct(perf.takeRate),
      holdingDurationAvgHours: avgHoldMs === null ? null : avgHoldMs / 3_600_000,
      tradingPreferences: (() => {
        const symbols = parseSymbolRates(perf.symbolRates)
        return symbols ? { symbols } : null
      })(),
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = chartPoints(rateChart, pct) // PnL(%) chart
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const dailyPnl = chartPoints(pnlChart, num) // daily PnL bars
  if (dailyPnl.length > 0) series.push({ timeframe: tf, metric: 'pnl_daily', points: dailyPnl })

  return {
    stats,
    series,
    nickname: base ? ((base.nickName as string) ?? null) : null,
    avatarUrlOrigin: base ? ((base.imgUrl as string) ?? null) : null,
  }
}

/** Current positions (GET trader-info/current-positions, { isHide, positions }). */
export function parseHtxPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const d = data(raw)
  const list = Array.isArray(d?.positions) ? (d.positions as Dict[]) : []
  const out: ParsedPosition[] = []
  for (const item of list) {
    const symbol = item.contractCode ?? item.symbol
    if (!symbol) continue
    out.push({
      symbol: String(symbol),
      side:
        item.positionSide === 'long' || item.positionSide === 'short'
          ? (item.positionSide as 'long' | 'short')
          : sideFromDirection(item.direction),
      leverage: num(item.leverRate),
      size: num(item.volume),
      entryPrice: num(item.openAvgPrice),
      markPrice: num(item.markPrice) ?? num(item.lastPrice),
      unrealizedPnl: num(item.profitUnreal),
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
 * History tab (GET trader-info/history-positions): closed positions, newest
 * first, { total, positions }. No position id → hash of
 * contractCode|openTime|offsetTime. avgCost = entry, avgOffset = exit,
 * totalProfit = realized PnL, offsetTime = close ts.
 */
export function parseHtxPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.positions) ? (d.positions as Dict[]) : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const symbol = item.contractCode ?? item.symbol
    if (!symbol) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.openTime),
      closedAt: iso(item.offsetTime),
      symbol: String(symbol),
      side: sideFromDirection(item.direction),
      leverage: num(item.leverRate),
      size: num(item.maxHoldVolume),
      entryPrice: num(item.avgCost),
      exitPrice: num(item.avgOffset),
      realizedPnl: num(item.totalProfit),
      dedupeHash: dedupeHash('htx_ph', symbol, item.openTime, item.offsetTime),
      raw: item,
    })
  }
  return out
}

export function parseHtxHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseHtxPositionHistory(raw, ctx)
    default:
      // followers tab is login-gated; orders/transfers not exposed publicly.
      throw new Error(`[htx] history surface ${kind} not supported`)
  }
}
