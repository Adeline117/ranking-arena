/**
 * BitMart AIHub copy-trading pure parsers — spec §7 #36 / §11.21.
 * Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-12 via SG VPS):
 *   - roi / mdd / win_rate / commission_ratio / pnl_ratio(position) are
 *     FRACTIONS ("0.312957" = 31.30%) — we store percent.
 *   - pnl / aum / equity are plain USDT strings; NAV is a fund-style net
 *     asset value (1.0 = par) stored verbatim in extras.nav (spec §12.3 —
 *     Arena Score v2 gold).
 *   - run_time / avg_holding_time are seconds; timestamps ISO-8601 Z.
 *   - position_type: 1 = long, 2 = short (verified against price direction
 *     vs realized profit sign on live closed positions).
 *   - order `way`: 1=open_long, 2=close_short, 3=close_long, 4=open_short
 *     (cross-checked against the same trader's position open/close events).
 *
 * Window enums (calibrated live against the sheet's per-window ROI):
 *   - master-ranking / chart / asset-preferences window_type:
 *     1=24H, 2=7D, 3=1M, 4=3M (ranking only supports 1-3 — no 3M board).
 *   - sheet rows carry `window` 1..7 (1=24H, 2=7D, 3=1M, 4=3M, 5+ clamp).
 *
 * Composite payload shapes (built by the adapter, replayable from RAW):
 *   profile bundle: { getByUuid, keyMetric, aumInfo, sheet, chart,
 *                     assetPreferences, radar, timeframe }
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

/** Fraction → percent without float dust (0.312957 → 31.2957). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

function iso(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function data(payload: unknown): Dict | null {
  const d = (payload as Dict)?.data
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Dict) : null
}

/** BitMart position_type: 1 = long, 2 = short. */
function side(v: unknown): 'long' | 'short' | null {
  const n = int(v)
  if (n === 1) return 'long'
  if (n === 2) return 'short'
  return null
}

/** Order `way` enum (see header note). */
const ORDER_WAY: Record<number, { kind: string; side: 'long' | 'short' }> = {
  1: { kind: 'open_long', side: 'long' },
  2: { kind: 'close_short', side: 'short' },
  3: { kind: 'close_long', side: 'long' },
  4: { kind: 'open_short', side: 'short' },
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/** Board-row extras → trader_stats.extras via registry aliases (NULL-collapse). */
function boardExtras(item: Dict): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const nav = num(item.nav)
  if (nav !== null) ext.nav = nav
  const plRatio = num(item.pl_ratio)
  if (plRatio !== null) ext.pnl_ratio = plRatio
  return Object.keys(ext).length > 0 ? ext : null
}

/**
 * Master list (GET master/master-ranking?page&size&order&window_type&
 * master_type=1). NOTE: `total` counts ALL masters including hidden ones —
 * each page is post-filtered server-side, so short pages are NORMAL
 * mid-crawl (the adapter paginates to ceil(total/size), not short-page).
 * master_tag is the style-tag enum (spec §12.2) → traders.meta + raw.
 */
export function parseBitmartLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const d = data(raw)
  const items = Array.isArray(d?.list) ? (d.list as Dict[]) : []
  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.uuid) continue
    const aiComment =
      item.ai_comment && typeof item.ai_comment === 'object' ? (item.ai_comment as Dict) : null
    rows.push({
      exchangeTraderId: String(item.uuid),
      // Positional in-page rank; re-anchored across pages by the caller.
      rank: i + 1,
      nickname: (item.master_name as string) || null,
      avatarUrlOrigin: (item.avatar as string) || null,
      walletAddress: null,
      // BitMart has AI-named masters but exposes no structured bot flag —
      // all rows are human; style enum kept for Arena Score v2 (spec §12.2).
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.roi),
      headlinePnl: num(item.pnl),
      // win_rate only ships inside the structured ai_comment block
      headlineWinRate: aiComment ? pct(aiComment.win_rate) : null,
      // Board carries mdd (fraction→pct, "0.251"=25.11%) and aum (absolute USD) —
      // were raw-only, so board-tier masters had no MDD/AUM.
      headlineMdd: pct(item.mdd),
      headlineAum: num(item.aum),
      // 跟单人数 on every board row → trader_stats.copier_count for board-tier
      // masters never deep-crawled (Phase A: was raw-only).
      headlineCopierCount: int(item.copiers),
      traderMeta: item.master_tag !== undefined ? { master_tag: int(item.master_tag) } : null,
      // Board-row NAV (unit net value, par 1.0) + 盈亏比 → trader_stats.extras via
      // registry aliases (nav / pnl_ratio). Profile promotes these too; the board
      // fills board-tier masters. Phase A.
      headlineExtras: boardExtras(item),
      // scores, profit share... verbatim
      raw: item,
    })
  }
  return { rows, reportedTotal: int(d?.total) }
}

interface ProfileBundle {
  getByUuid?: unknown
  keyMetric?: unknown
  aumInfo?: unknown
  sheet?: unknown
  chart?: unknown
  assetPreferences?: unknown
  radar?: unknown
  timeframe?: number
}

/** Canonical TF → sheet `window` row (1=24H kept in extras only). */
const SHEET_WINDOW: Record<number, number> = { 7: 2, 30: 3, 90: 4 }

function sheetWindow(sheet: Dict | null, window: number): Dict | null {
  const list = Array.isArray(sheet?.list) ? (sheet.list as Dict[]) : []
  const row = list.find((r) => int(r.window) === window)
  return row ?? null
}

/**
 * Profile bundle, one per TF:
 *   getByUuid:        identity + bio + commission_ratio + start_at
 *   keyMetric:        Master Key Metrics (Latest NAV, runtime, trades/day,
 *                     win rate, top-3 volume share, avg holding, equity...)
 *   aumInfo:          follower_num + AUM
 *   sheet:            Master Performance table (windows 1..7; one call
 *                     covers every TF — as_of = data.last_updated_at)
 *   chart:            daily ROI/PnL (period + cumulative) for the TF
 *   assetPreferences: per-contract traded volume donut for the TF
 *   radar:            rank rings percentiles (ROI / MDD / P&L ratio /
 *                     trades-per-day / top3 share)
 */
export function parseBitmartProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 30) as Timeframe
  const master = (data(bundle.getByUuid)?.master ?? null) as Dict | null
  const keyMetric = data(bundle.keyMetric)
  const aumMaster = (data(bundle.aumInfo)?.master ?? null) as Dict | null
  const sheet = data(bundle.sheet)
  const chart = data(bundle.chart)
  const prefs = data(bundle.assetPreferences)
  const radar = data(bundle.radar)

  const stats: ParsedStats[] = []
  const win = sheetWindow(sheet, SHEET_WINDOW[tf === 0 ? 90 : tf] ?? 3)
  if (win || keyMetric) {
    const winMaster = (win?.master ?? null) as Dict | null
    const winFollower = (win?.follower ?? null) as Dict | null

    const extras: Record<string, unknown> = {}
    if (keyMetric) {
      // Latest NAV — fund-style net asset value (THE Arena Score v2 input)
      extras.nav = num(keyMetric.nav)
      extras.total_equity = num(keyMetric.total_equity)
      extras.unrealized_pnl = num(keyMetric.un_pnl)
      extras.trades_per_day = num(keyMetric.trade_days) // UI "Trades/Day"
      extras.top_volume_share = pct(keyMetric.top_volume_share)
      extras.realized_profit_sharing = num(keyMetric.realized_profit_sharing)
      extras.run_time_seconds = int(keyMetric.run_time)
      const lastTraded = iso(keyMetric.last_traded_at)
      if (lastTraded) extras.last_traded_at = lastTraded
      const startAt = iso(keyMetric.start_at)
      if (startAt) extras.start_at = startAt
    }
    if (winMaster?.pl_ratio !== undefined) extras.profit_loss_ratio = num(winMaster.pl_ratio)
    if (radar) {
      extras.rank_rings = {
        roi_point: num(radar.roi_point),
        max_drawdown_point: num(radar.max_drawdown_point),
        trades_per_day_point: num(radar.trades_per_day_point),
        top3_volume_share_point: num(radar.top3_volume_share_ratio_point),
        profit_loss_ratio_point: num(radar.profit_loss_ratio_point),
      }
    }
    const win24 = sheetWindow(sheet, 1)
    if (win24) extras.window_24h = win24
    if (master) {
      if (typeof master.introduction === 'string' && master.introduction) {
        extras.bio = master.introduction
      }
      extras.min_copy_amount = num(master.min_copy_amount)
      const startAt = iso(master.start_at)
      if (startAt) extras.master_since = startAt
      if (master.leverage_limit) extras.leverage_limit = num(master.leverage_limit)
    }

    const avgHoldSecs = keyMetric ? num(keyMetric.avg_holding_time) : null
    stats.push({
      timeframe: tf,
      // The site stamps its own refresh time — use it as as_of (spec §11.14
      // "Last Updated" pattern); fall back to scrape time.
      asOf: iso(sheet?.last_updated_at) ?? ctx.scrapedAt,
      roi: winMaster ? pct(winMaster.roi) : null,
      pnl: winMaster ? num(winMaster.pnl) : null,
      sharpe: null,
      mdd: winMaster ? pct(winMaster.mdd) : null,
      winRate: keyMetric ? pct(keyMetric.win_rate) : null,
      winPositions: null,
      totalPositions: null,
      copierPnl: winFollower ? num(winFollower.pnl) : null,
      copierCount: aumMaster ? int(aumMaster.follower_num) : null,
      aum: aumMaster ? num(aumMaster.aum) : null,
      volume: null,
      profitShareRate: master ? pct(master.commission_ratio) : null,
      holdingDurationAvgHours: avgHoldSecs === null ? null : avgHoldSecs / 3600,
      tradingPreferences: Array.isArray(prefs?.list) ? { contracts: prefs.list } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const chartList = Array.isArray(chart?.list) ? (chart.list as Dict[]) : []
  const roiPoints: Array<{ ts: string; value: number }> = []
  const pnlPoints: Array<{ ts: string; value: number }> = []
  const pnlDaily: Array<{ ts: string; value: number }> = []
  for (const point of chartList) {
    const ts = iso(point.statistical_time)
    if (ts === null) continue
    const roi = pct(point.roi_total)
    if (roi !== null) roiPoints.push({ ts, value: roi })
    const pnl = num(point.pnl_total)
    if (pnl !== null) pnlPoints.push({ ts, value: pnl })
    const daily = num(point.pnl)
    if (daily !== null) pnlDaily.push({ ts, value: daily })
  }
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })
  if (pnlDaily.length > 0) series.push({ timeframe: tf, metric: 'pnl_daily', points: pnlDaily })

  return {
    stats,
    series,
    nickname: master ? ((master.name as string) ?? null) : null,
    avatarUrlOrigin: master ? ((master.avatar_link as string) ?? null) : null,
  }
}

/**
 * Open positions (GET position/list?uuid&page&size): mark price, unrealized
 * PnL (`pnl`) and margin metrics are public.
 */
export function parseBitmartPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const d = data(raw)
  const list = Array.isArray(d?.list) ? (d.list as Dict[]) : []
  const out: ParsedPosition[] = []
  for (const item of list) {
    if (!item.contract_name) continue
    out.push({
      symbol: String(item.contract_name),
      side: side(item.position_type),
      leverage: num(item.bind_leverage),
      size: num(item.size),
      entryPrice: num(item.open_avg_price),
      markPrice: num(item.mark_price),
      unrealizedPnl: num(item.pnl),
      raw: item,
    })
  }
  return out
}

function parseBitmartPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.positions)
    ? (d.positions as Dict[])
    : Array.isArray(d?.list)
      ? (d.list as Dict[])
      : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    if (!item.contract_name) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.created_at),
      closedAt: iso(item.updated_at),
      symbol: String(item.contract_name),
      side: side(item.position_type),
      leverage: num(item.bind_leverage),
      size: num(item.close_vol),
      entryPrice: num(item.open_avg_price),
      exitPrice: num(item.close_avg_price),
      realizedPnl: num(item.realised_profit), // `pnl`/`roi` here are ROI fractions
      dedupeHash: item.position_id
        ? dedupeHash('bitmart_ph', item.position_id)
        : dedupeHash('bitmart_ph', item.contract_name, item.created_at, item.updated_at),
      raw: item,
    })
  }
  return out
}

function parseBitmartOrders(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.orders)
    ? (d.orders as Dict[])
    : Array.isArray(d?.list)
      ? (d.list as Dict[])
      : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const ts = iso(item.created_at)
    if (ts === null) continue
    const way = ORDER_WAY[int(item.way) ?? -1] ?? null
    out.push({
      kind: 'orders',
      ts,
      orderKind: way?.kind ?? null,
      symbol: item.contract_name ? String(item.contract_name) : null,
      side: way?.side ?? null,
      price: num(item.done_avg_price) ?? num(item.price),
      qty: num(item.done_qty) ?? num(item.qty),
      dedupeHash: item.order_id
        ? dedupeHash('bitmart_or', item.order_id)
        : dedupeHash('bitmart_or', item.contract_name, item.created_at, item.vol),
      raw: item,
    })
  }
  return out
}

/** from/to: 1 = futures (copy-trading) account, 2 = spot wallet. */
function parseBitmartTransfers(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.list)
    ? (d.list as Dict[])
    : Array.isArray(d?.record)
      ? (d.record as Dict[])
      : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const ts = iso(item.transfer_time)
    if (ts === null) continue
    const to = int(item.to)
    const from = int(item.from)
    out.push({
      kind: 'transfers',
      ts,
      direction: to === 1 ? 'in' : from === 1 ? 'out' : null,
      asset: item.coin ? String(item.coin) : null,
      amount: num(item.amount),
      dedupeHash: dedupeHash(
        'bitmart_tr',
        item.transfer_time,
        item.coin,
        item.amount,
        item.from,
        item.to
      ),
      raw: item,
    })
  }
  return out
}

export function parseBitmartHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseBitmartPositionHistory(raw, ctx)
    case 'orders':
      return parseBitmartOrders(raw, ctx)
    case 'transfers':
      return parseBitmartTransfers(raw, ctx)
    default:
      // follower list requires auth ("Forbidden|empty token") — copier
      // COUNT still ships via aum/info into stats.copierCount.
      throw new Error(`[bitmart] history surface ${kind} not supported`)
  }
}
