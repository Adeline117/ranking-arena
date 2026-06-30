/**
 * CoinEx Futures copy-trading pure parsers — spec §7 #12 / §11.8 / §11.23.
 * Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-11): every numeric is
 * a STRING; rates (profit_rate / winning_rate / mdd / profit_share_rate) are
 * plain fractions ("0.35228131" = 35.23%) — we store percent, matching the
 * Bitget/Bybit/MEXC adapters. PnL/funds are plain USDT strings. Timestamps
 * are SECONDS epochs (UTC) — ×1000 before Date.
 *
 * Endpoint payload shapes (base https://www.coinex.com/res/copy-trading/public):
 *   leaderboard: GET traders?data_type=profit_rate&time_range=DAY{7,30,90}
 *                  &hide_full=0&page&limit≤100
 *                → { data: { has_next, curr_page, count, total, total_page,
 *                            data: [card...] } }
 *   profile bundle (composite, built by the adapter, replayable from RAW):
 *     { traderDetail, tradeData, profitSeries, aumSeries, marketPercent,
 *       timeframe }
 *     - trader-detail?trader_id=         identity + intro + 30d roi sparkline
 *                                        (time_range param IGNORED — verified)
 *     - trade-data?trader_id=            Data Overview block (TF-insensitive,
 *                                        matches spec §11.8: only charts are
 *                                        TF-toggled)
 *     - profit-series?trader_id&time_range  [ts, lead, copier, overall] PNL
 *     - aum-series?trader_id&time_range     [ts, aum]
 *     - market-percent?trader_id&time_range Futures Trading Preferences
 *   positions:   GET current-position?trader_id=        (plain array)
 *   history:     GET finished-position?trader_id&page&limit (lead history)
 *   copiers:     GET followers?trader_id&page&limit (PII, never rendered)
 *
 * Side semantics (CoinEx futures convention): side 2 = long(buy),
 * side 1 = short(sell). `type` is margin mode (1 isolated / 2 cross) — kept
 * in raw only.
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

/** String fraction → percent without float dust ("0.35228131" → 35.2281). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

/** CoinEx epochs are SECONDS. */
function iso(secEpoch: unknown): string | null {
  const n = num(secEpoch)
  return n === null || n <= 0 ? null : new Date(n * 1000).toISOString()
}

function data(payload: unknown): unknown {
  return (payload as Dict)?.data
}

/** Paged envelope: { has_next, curr_page, count, total?, data: [...] }. */
function pagedData(payload: unknown): { items: Dict[]; total: number | null } {
  const d = data(payload) as Dict | null
  const items = Array.isArray(d?.data) ? (d.data as Dict[]) : []
  return { items, total: int(d?.total) }
}

/** CoinEx futures side: 2 = long (buy), 1 = short (sell). */
function side(v: unknown): 'long' | 'short' | null {
  const n = int(v)
  if (n === 2) return 'long'
  if (n === 1) return 'short'
  return null
}

/** [ts_seconds, "value"] tuples → series points. */
function tuplePoints(
  rows: unknown,
  valueIndex: number,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const ts = iso(row[0])
    const value = decode(row[valueIndex])
    if (ts === null || value === null) continue
    points.push({ ts, value })
  }
  return points
}

export function parseCoinexLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const { items, total } = pagedData(raw)
  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.trader_id) continue
    rows.push({
      exchangeTraderId: String(item.trader_id),
      rank: i + 1, // positional; re-anchored across pages by the processor
      nickname: (item.nickname as string) ?? null,
      avatarUrlOrigin: (item.avatar as string) ?? null,
      walletAddress: null,
      traderKind: 'human', // no bot product on this board
      botStrategy: null,
      headlineRoi: pct(item.profit_rate),
      headlinePnl: num(item.profit_amount),
      headlineWinRate: pct(item.winning_rate),
      // Board carries mdd (fraction, "0.0594"→5.94%) and aum (absolute USD) — extract
      // them (were raw-only, so board-tier traders had no MDD/AUM).
      headlineMdd: pct(item.mdd),
      headlineAum: num(item.aum),
      traderMeta: null,
      // copier slots, profit share, sparkline... kept verbatim
      raw: item,
    })
  }
  return { rows, reportedTotal: total }
}

interface ProfileBundle {
  traderDetail?: unknown
  tradeData?: unknown
  profitSeries?: unknown
  aumSeries?: unknown
  marketPercent?: unknown
  timeframe?: number
}

/**
 * Profile bundle, one per TF. The Data Overview block (trade-data) is
 * TF-INSENSITIVE (spec §11.8 — only the charts carry the TF toggle), so its
 * scalar stats repeat across TF rows; the TF-scoped truth lives in the
 * profit/aum series and in the board headline columns.
 */
export function parseCoinexProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 90) as Timeframe
  const detail = data(bundle.traderDetail) as Dict | null
  const overview = data(bundle.tradeData) as Dict | null
  const profitRows = data(bundle.profitSeries)
  const aumRows = data(bundle.aumSeries)
  const markets = data(bundle.marketPercent)

  const stats: ParsedStats[] = []
  if (overview) {
    const extras: Record<string, unknown> = {}
    if (overview.equity !== undefined) extras.equity = num(overview.equity)
    if (overview.margin_amount !== undefined) extras.margin_amount = num(overview.margin_amount)
    if (overview.total_profit_amount !== undefined) {
      extras.total_profit_amount = num(overview.total_profit_amount)
    }
    if (overview.profit_share_amount !== undefined) {
      extras.profit_share_amount = num(overview.profit_share_amount)
    }
    if (overview.total_follower_count !== undefined) {
      extras.copier_count_history = int(overview.total_follower_count)
    }
    if (overview.favorite_count !== undefined) {
      extras.favorite_count = int(overview.favorite_count)
    }
    if (overview.max_follower_num !== undefined) {
      extras.max_copier_slots = int(overview.max_follower_num)
    }
    if (overview.trade_days !== undefined) extras.trade_days = int(overview.trade_days)
    const lastTrade = iso(overview.last_trade_at)
    if (lastTrade) extras.last_trade_time = lastTrade
    if (detail?.introduction) extras.introduction = detail.introduction
    if (detail?.min_copy_amount !== undefined) {
      extras.min_copy_amount = num(detail.min_copy_amount)
    }
    if (detail?.max_copy_amount !== undefined) {
      extras.max_copy_amount = num(detail.max_copy_amount)
    }

    const aumPoints = tuplePoints(aumRows, 1, num)
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(overview.profit_rate),
      pnl: num(overview.profit_amount),
      sharpe: null,
      mdd: pct(overview.mdd),
      winRate: pct(overview.winning_rate),
      winPositions: int(overview.profit_count),
      totalPositions: int(overview.trade_count),
      copierPnl: num(overview.follower_profit_amount),
      copierCount: int(overview.cur_follower_num),
      // No scalar AUM on the overview — use the latest AUM-series point.
      aum: aumPoints.length > 0 ? aumPoints[aumPoints.length - 1].value : null,
      volume: null,
      profitShareRate: pct(detail?.profit_share_rate),
      holdingDurationAvgHours: null,
      tradingPreferences: Array.isArray(markets) ? { markets } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  // PNL Data chart [ts, lead, copier, overall] (spec §11.8 three series).
  const pnlPoints = tuplePoints(profitRows, 1, num)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })
  const copierPnlPoints = tuplePoints(profitRows, 2, num)
  if (copierPnlPoints.length > 0) {
    series.push({ timeframe: tf, metric: 'pnl_copiers', points: copierPnlPoints })
  }
  const overallPnlPoints = tuplePoints(profitRows, 3, num)
  if (overallPnlPoints.length > 0) {
    series.push({ timeframe: tf, metric: 'pnl_overall', points: overallPnlPoints })
  }
  const aumSeriesPoints = tuplePoints(aumRows, 1, num)
  if (aumSeriesPoints.length > 0) {
    series.push({ timeframe: tf, metric: 'aum', points: aumSeriesPoints })
  }
  // trader-detail's roi sparkline IGNORES time_range (fixed ~30d window,
  // verified 2026-06-11) — only attach it to the 30d profile row.
  if (tf === 30) {
    const roiPoints = tuplePoints(detail?.profit_rate_series, 1, pct)
    if (roiPoints.length > 0) series.push({ timeframe: 30, metric: 'roi', points: roiPoints })
  }

  return {
    stats,
    series,
    nickname: detail ? ((detail.nickname as string) ?? null) : null,
    avatarUrlOrigin: detail ? ((detail.avatar_url as string) ?? null) : null,
  }
}

/** Current lead orders (GET current-position?trader_id=, plain array). */
export function parseCoinexPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const list = data(raw)
  if (!Array.isArray(list)) return []
  const out: ParsedPosition[] = []
  for (const item of list as Dict[]) {
    if (!item.market) continue
    out.push({
      symbol: String(item.market),
      side: side(item.side),
      leverage: num(item.leverage),
      size: num(item.amount),
      entryPrice: num(item.open_price),
      markPrice: null, // not exposed; liq_price kept in raw
      unrealizedPnl: num(item.profit_unreal),
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
 * Lead History (GET finished-position, spec §11.23): closed lead positions,
 * newest first; position_id is the stable natural key. update_time = close
 * time; latest_price ≈ avg closing price (no dedicated close-price field).
 */
export function parseCoinexPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const { items } = pagedData(raw)
  const out: ParsedHistoryRow[] = []
  for (const item of items) {
    if (!item.market) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.create_time),
      closedAt: iso(item.update_time),
      symbol: String(item.market),
      side: side(item.side),
      leverage: num(item.leverage),
      size: num(item.amount_max),
      entryPrice: num(item.open_price),
      exitPrice: num(item.latest_price),
      realizedPnl: num(item.profit_real),
      dedupeHash: item.position_id
        ? dedupeHash('coinex_ph', item.position_id)
        : dedupeHash('coinex_ph', item.market, item.create_time, item.update_time),
      raw: item,
    })
  }
  return out
}

/**
 * Copy Trader tab (GET followers, spec §11.23). follower_name is a nick or
 * masked email — stored for dedupe/aggregates only, NEVER rendered (spec §6
 * copier PII). No row timestamp → ts = ctx.scrapedAt.
 */
export function parseCoinexCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const { items } = pagedData(raw)
  const out: ParsedHistoryRow[] = []
  for (const item of items) {
    if (item.follower_name === undefined || item.follower_name === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(item.follower_name),
      copierPnl: num(item.total_copy_earn_amount),
      copierInvested: num(item.fund_amount),
      copyDurationDays: null, // not exposed by this endpoint
      dedupeHash: dedupeHash(
        'coinex_cp',
        item.follower_name,
        item.fund_amount,
        item.total_copy_earn_amount
      ),
      raw: item,
    })
  }
  return out
}

export function parseCoinexHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseCoinexPositionHistory(raw, ctx)
    case 'copiers':
      return parseCoinexCopiers(raw, ctx)
    default:
      // order-level fills and transfers are not exposed publicly.
      throw new Error(`[coinex] history surface ${kind} not supported`)
  }
}
