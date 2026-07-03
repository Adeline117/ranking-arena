/**
 * serving → legacy-tab adapter (trader-detail unification, 2026-06-13).
 *
 * GOAL: every source — legacy AND arena-serving — renders the SAME rich tab
 * frontend (OverviewTab / StatsTab / PortfolioTab). Those tabs are prop-driven
 * and consume the (now @deprecated but still wired) shapes in
 * lib/data/trader-types.ts. This module maps the serving data shapes
 * (core.modules + records + first-screen) onto those legacy props so the
 * serving branch of TraderProfileClient can feed the rich tabs instead of the
 * trimmed ServingProfilePanel.
 *
 * ROADMAP
 *   Phase 1 (this file): pure mappers — records → PortfolioItem[] /
 *           PositionHistoryItem[], serving stats+first-screen → TraderProfile /
 *           TraderPerformance. New file, additive, zero wiring → zero risk.
 *   Phase 2: wire into TraderProfileClient's serving branch behind a flag;
 *           feed PortfolioTab + the position-history table first (the paginated
 *           tables users miss most). Validate in an isolated worktree (shared
 *           core file).
 *   Phase 3: Overview/Stats tabs — needs all-timeframe stats (serving fetches
 *           ONE tf at a time; TraderPerformance bundles roi_7d/30d/90d), so the
 *           wiring fetches the 3 core modules in parallel and merges here.
 *
 * Missing fields NULL-collapse (legacy components already tolerate undefined).
 */

import type { PortfolioItem, TraderProfile, TraderStats } from '@/lib/data/trader-types'
import type { PositionHistoryEntry } from '@/app/(app)/u/[handle]/components/types'
import type { ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'

type Row = Record<string, unknown>
type SeriesPoint = { ts: string; value: number }
type Series = Record<string, SeriesPoint[]>
type Stats = Record<string, number | string | null>

/** Per-timeframe {date, roi, pnl} shape the legacy Stats/Overview tabs consume
 *  (EquityCurveData) and the per-tf asset weights (AssetBreakdownData). */
export interface TfChartPoint {
  date: string
  roi: number
  pnl: number
}
export interface EquityCurveByTf {
  '7D': TfChartPoint[]
  '30D': TfChartPoint[]
  '90D': TfChartPoint[]
}
export interface AssetWeight {
  symbol: string
  weightPct: number
}
export interface AssetBreakdownByTf {
  '7D': AssetWeight[]
  '30D': AssetWeight[]
  '90D': AssetWeight[]
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** 'long'/'short' | 'buy'/'sell' | 'LONG' → 'long' | 'short'. */
function toDirection(v: unknown): 'long' | 'short' {
  const s = str(v).toLowerCase()
  return s === 'short' || s === 'sell' ? 'short' : 'long'
}

/** Serving `positions` records → legacy PortfolioItem (current holdings).
 *
 *  PortfolioItem.invested / .pnl are PERCENTAGES (legacy trader_portfolio
 *  weight_pct / pnl_pct semantics — PortfolioCurrentView renders `%`), while
 *  serving position rows carry USD absolutes (margin / unrealized_pnl /
 *  notional). Derive:
 *    weight% = |notional| share of Σ|notional| — NOT margin share (cross-margin
 *              rows report margin:0) — clamped to [0,100];
 *    pnl%    = exchange-reported roe, else unrealized_pnl/margin, else
 *              unrealized_pnl/|notional| (cross rows), else NaN → the view's
 *              Number.isFinite guard renders '—'. */
export function positionsToPortfolio(rows: Row[]): PortfolioItem[] {
  const notionalOf = (r: Row): number => {
    const explicit = Math.abs(num(r.notional))
    if (explicit > 0) return explicit
    return num(r.mark_price ?? r.price) * Math.abs(num(r.size))
  }
  const totalNotional = rows.reduce((sum, r) => sum + notionalOf(r), 0)
  return rows.map((r) => {
    const markPrice = num(r.mark_price ?? r.price)
    const size = num(r.size)
    const margin = num(r.margin)
    const upnl = num(r.unrealized_pnl ?? r.pnl)
    const notional = notionalOf(r)
    const pnlPct =
      r.roe != null
        ? num(r.roe)
        : margin > 0
          ? (upnl / margin) * 100
          : notional > 0
            ? (upnl / notional) * 100
            : NaN
    const weightPct =
      totalNotional > 0 ? Math.min(Math.max((notional / totalNotional) * 100, 0), 100) : NaN
    return {
      market: str(r.symbol ?? r.market),
      direction: toDirection(r.side ?? r.direction),
      invested: weightPct,
      pnl: pnlPct,
      value: markPrice && size ? markPrice * size : num(r.value),
      price: markPrice,
    }
  })
}

/** Serving `position_history` records → legacy PositionHistoryEntry (closed),
 *  the shape the StatsTab + PortfolioTab history tables consume. Fields the
 *  serving record doesn't carry (positionType / marginMode / maxPositionSize)
 *  NULL-collapse to sane defaults (the tables tolerate empty strings / 0). */
export function historyToPositionHistory(rows: Row[]): PositionHistoryEntry[] {
  return rows.map((r) => {
    const entry = num(r.entry_price ?? r.entryPrice)
    const exit = num(r.exit_price ?? r.exitPrice)
    // serving stores realized_pnl (absolute); derive % when a notional exists,
    // else fall back to a precomputed pct field if the raw row carried one.
    const realizedPnl = num(r.realized_pnl ?? r.pnl)
    const size = num(r.size ?? r.closed_size)
    const notional = entry && size ? entry * size : 0
    // Prefer the exchange-reported ROI (arena_records_page surfaces raw->>'roi'),
    // then a precomputed pct, then derive from realized_pnl / notional.
    const pnlPct =
      r.roi != null
        ? num(r.roi)
        : r.realized_pnl_pct != null
          ? num(r.realized_pnl_pct)
          : notional
            ? (realizedPnl / notional) * 100
            : 0
    return {
      symbol: str(r.symbol),
      direction: toDirection(r.side ?? r.direction),
      positionType: str(r.position_type ?? r.contract_type) || 'perpetual',
      marginMode: str(r.margin_mode),
      openTime: str(r.opened_at ?? r.openTime),
      closeTime: str(r.closed_at ?? r.closeTime),
      entryPrice: entry,
      exitPrice: exit,
      maxPositionSize: num(r.max_open_interest ?? r.max_position_size ?? r.size ?? r.closed_size),
      closedSize: size,
      pnlUsd: realizedPnl,
      pnlPct,
      status: str(r.status) || 'closed',
    }
  })
}

export interface ServingProfileInput {
  exchangeTraderId: string
  nickname: string | null
  avatarMirrorUrl: string | null
  source: string
  copierCount?: number | null
  bio?: string | null
}

/** first-screen identity → legacy TraderProfile. */
export function servingToTraderProfile(input: ServingProfileInput): TraderProfile {
  return {
    handle: input.exchangeTraderId,
    display_name: input.nickname,
    id: input.exchangeTraderId,
    trader_key: input.exchangeTraderId,
    bio: input.bio ?? undefined,
    copiers: input.copierCount ?? undefined,
    avatar_url: input.avatarMirrorUrl ?? undefined,
    source: input.source,
    isRegistered: false,
  }
}

/**
 * Per-timeframe serving stats → legacy TraderPerformance. Pass the stats blob
 * for each timeframe you have (any subset); the matching roi / pnl / win_rate
 * slots are filled and the rest NULL-collapse.
 */
export function servingStatsToPerformance(byTf: {
  tf7?: Record<string, number | string | null> | null
  tf30?: Record<string, number | string | null> | null
  tf90?: Record<string, number | string | null> | null
  // Sortino/Calmar/Volatility live in trader_stats.EXTRAS (not typed columns)
  // for every CEX that provides them (bybit/blofin/…). The Overview
  // MetricBadgesGrid reads sortino_ratio_{7d,30d,90d}/calmar; passing only stats
  // dashed them (audit 2026-07-03: read s90.sortino from stats, always undefined).
  extras7?: Record<string, unknown> | null
  extras30?: Record<string, unknown> | null
  extras90?: Record<string, unknown> | null
}): ExtendedPerformance {
  const perf: ExtendedPerformance = {}
  const s7 = byTf.tf7
  const s30 = byTf.tf30
  const s90 = byTf.tf90
  // Set only when present so a source that omits a metric NULL-collapses (renders
  // '--') instead of a misleading 0 — matches the ServingProfilePanel MetricGrid.
  const set = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  // Risk ratios from extras (per-TF). sortino/calmar are never typed columns.
  const ex = (o: Record<string, unknown> | null | undefined, k: string): number | undefined =>
    set(o?.[k])
  if (s7) {
    perf.roi_7d = num(s7.roi)
    perf.pnl_7d = num(s7.pnl)
    perf.win_rate_7d = set(s7.win_rate)
    perf.max_drawdown_7d = set(s7.mdd)
    perf.sharpe_ratio_7d = set(s7.sharpe)
    perf.sortino_ratio_7d = ex(byTf.extras7, 'sortino')
    perf.calmar_ratio_7d = ex(byTf.extras7, 'calmar')
    perf.winning_positions_7d = set(s7.win_positions)
    perf.total_positions_7d = set(s7.total_positions)
  }
  if (s30) {
    perf.roi_30d = num(s30.roi)
    perf.pnl_30d = num(s30.pnl)
    perf.win_rate_30d = set(s30.win_rate)
    perf.max_drawdown_30d = set(s30.mdd)
    perf.sharpe_ratio_30d = set(s30.sharpe)
    perf.sortino_ratio_30d = ex(byTf.extras30, 'sortino')
    perf.calmar_ratio_30d = ex(byTf.extras30, 'calmar')
    perf.winning_positions_30d = set(s30.win_positions)
    perf.total_positions_30d = set(s30.total_positions)
  }
  if (s90) {
    perf.roi_90d = num(s90.roi)
    perf.pnl = num(s90.pnl)
    perf.win_rate = set(s90.win_rate)
    perf.max_drawdown = set(s90.mdd)
    perf.sharpe_ratio = set(s90.sharpe)
    // 90d-primary, fall back to shorter TFs (risk ratios are often only computed
    // on a subset of timeframes) — mirrors the registry MetricGrid cross-TF fill.
    perf.sortino_ratio =
      ex(byTf.extras90, 'sortino') ?? ex(byTf.extras30, 'sortino') ?? ex(byTf.extras7, 'sortino')
    perf.calmar_ratio =
      ex(byTf.extras90, 'calmar') ?? ex(byTf.extras30, 'calmar') ?? ex(byTf.extras7, 'calmar')
    perf.winning_positions = set(s90.win_positions)
    perf.total_positions = set(s90.total_positions)
  }
  return perf
}

/** Merge a serving module's roi + pnl series into [{date, roi, pnl}] (legacy
 *  EquityCurve point), de-duped by day and sorted — same logic as CoreCharts. */
function mergeRoiPnl(series: Series | undefined): TfChartPoint[] {
  if (!series) return []
  const roi = series.roi ?? series.roi_trading ?? []
  const pnl = series.pnl ?? series.cumulative_pnl ?? series.pnl_trading ?? []
  const accountValue = series.account_value ?? series.equity ?? []
  const byDate = new Map<string, TfChartPoint>()
  for (const p of roi) {
    const date = p.ts.slice(0, 10)
    byDate.set(date, { date, roi: p.value, pnl: byDate.get(date)?.pnl ?? 0 })
  }
  for (const p of pnl) {
    const date = p.ts.slice(0, 10)
    const row = byDate.get(date) ?? { date, roi: 0, pnl: 0 }
    row.pnl = p.value
    byDate.set(date, row)
  }
  const points = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))

  // Some sources (e.g. hyperliquid) expose only a pnl + account_value series and
  // NO roi series — every point above defaulted roi:0, which silently poisoned
  // the Copy-Trade Simulator (always +0.0%) and the Daily-Returns histogram
  // (every day bucketed at 0%). Derive roi from pnl against the deployed
  // principal at each point: base_t = account_value_t − pnl_t (net capital,
  // deposit-aware — a plain account_value_0 base blows up when the account
  // started tiny then took a large deposit). Only when a genuine roi series is
  // truly absent — never to overwrite real (possibly flat) roi values.
  if (roi.length === 0 && pnl.length > 0 && accountValue.length > 0) {
    const avByDate = new Map<string, number>()
    for (const p of accountValue) avByDate.set(p.ts.slice(0, 10), p.value)
    for (const row of points) {
      const av = avByDate.get(row.date)
      if (av == null) continue
      const base = av - row.pnl
      if (base > 0) row.roi = (row.pnl / base) * 100
    }
  }
  return points
}

/** Per-timeframe serving series → legacy EquityCurveData ({7D,30D,90D}). */
export function servingSeriesToEquityCurve(byTf: {
  tf7?: Series | null
  tf30?: Series | null
  tf90?: Series | null
}): EquityCurveByTf {
  return {
    '7D': mergeRoiPnl(byTf.tf7 ?? undefined),
    '30D': mergeRoiPnl(byTf.tf30 ?? undefined),
    '90D': mergeRoiPnl(byTf.tf90 ?? undefined),
  }
}

/** extras.trading_preferences.assets → [{symbol, weightPct}]. */
function extrasToAssets(extras: Row | null | undefined): AssetWeight[] {
  const tp = (extras?.trading_preferences ?? null) as { assets?: unknown } | null
  const raw = Array.isArray(tp?.assets) ? (tp!.assets as Row[]) : []
  return raw
    .filter((a) => typeof a.asset === 'string' && Number.isFinite(Number(a.volume)))
    .map((a) => ({ symbol: String(a.asset), weightPct: Number(a.volume) }))
}

/** Per-timeframe serving extras → legacy AssetBreakdownData. */
export function servingToAssetBreakdown(byTf: {
  tf7?: Row | null
  tf30?: Row | null
  tf90?: Row | null
}): AssetBreakdownByTf {
  return {
    '7D': extrasToAssets(byTf.tf7),
    '30D': extrasToAssets(byTf.tf30),
    '90D': extrasToAssets(byTf.tf90),
  }
}

/** 90d serving stats + extras → legacy TraderStats (trade-quality block +
 *  additionalStats). Missing fields NULL-collapse (tabs tolerate undefined). */
export function servingToStats(stats: Stats | null, extras: Row | null): TraderStats {
  const e = extras ?? {}
  const out: TraderStats = {}
  const avgProfit = num(e.avg_profit ?? e.avgProfit)
  const avgLoss = num(e.avg_loss ?? e.avgLoss)
  const winPos = num(stats?.win_positions)
  const totalPos = num(stats?.total_positions)
  if (avgProfit || avgLoss || totalPos) {
    out.trading = {
      totalTrades12M: totalPos,
      avgProfit,
      avgLoss,
      profitableTradesPct: totalPos ? (winPos / totalPos) * 100 : 0,
    }
  }
  const tradesPerWeek = num(e.trades_per_week ?? e.weekly_trades)
  const sharpe = num(stats?.sharpe)
  const mdd = num(stats?.mdd)
  const volume = num(stats?.volume)
  out.additionalStats = {
    tradesPerWeek: tradesPerWeek || undefined,
    avgHoldingTime: typeof e.avg_holding_time === 'string' ? e.avg_holding_time : undefined,
    riskScore: num(e.risk_rating) || undefined,
    volume90d: volume || undefined,
    maxDrawdown: mdd || undefined,
    sharpeRatio: sharpe || undefined,
  }
  return out
}
