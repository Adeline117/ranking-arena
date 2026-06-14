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

import type {
  PortfolioItem,
  PositionHistoryItem,
  TraderPerformance,
  TraderProfile,
} from '@/lib/data/trader-types'

type Row = Record<string, unknown>

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

/** Serving `positions` records → legacy PortfolioItem (current holdings). */
export function positionsToPortfolio(rows: Row[]): PortfolioItem[] {
  return rows.map((r) => {
    const markPrice = num(r.mark_price ?? r.price)
    const size = num(r.size)
    return {
      market: str(r.symbol ?? r.market),
      direction: toDirection(r.side ?? r.direction),
      invested: num(r.margin ?? r.invested),
      pnl: num(r.unrealized_pnl ?? r.pnl),
      value: markPrice && size ? markPrice * size : num(r.value),
      price: markPrice,
    }
  })
}

/** Serving `position_history` records → legacy PositionHistoryItem (closed). */
export function historyToPositionHistory(rows: Row[]): PositionHistoryItem[] {
  return rows.map((r) => {
    const entry = num(r.entry_price ?? r.entryPrice)
    const exit = num(r.exit_price ?? r.exitPrice)
    // serving stores realized_pnl (absolute); derive % when a notional exists,
    // else fall back to a precomputed pct field if the raw row carried one.
    const realizedPnl = num(r.realized_pnl ?? r.pnl)
    const size = num(r.size ?? r.closed_size)
    const notional = entry && size ? entry * size : 0
    const pnlPct =
      r.realized_pnl_pct != null
        ? num(r.realized_pnl_pct)
        : notional
          ? (realizedPnl / notional) * 100
          : 0
    return {
      symbol: str(r.symbol),
      direction: toDirection(r.side ?? r.direction),
      entryPrice: entry,
      exitPrice: exit,
      pnlPct,
      openTime: str(r.opened_at ?? r.openTime),
      closeTime: str(r.closed_at ?? r.closeTime),
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
}): TraderPerformance {
  const perf: TraderPerformance = {}
  const s7 = byTf.tf7
  const s30 = byTf.tf30
  const s90 = byTf.tf90
  if (s7) {
    perf.roi_7d = num(s7.roi)
    perf.pnl_7d = num(s7.pnl)
    perf.win_rate_7d = num(s7.win_rate)
    perf.max_drawdown_7d = num(s7.mdd)
  }
  if (s30) {
    perf.roi_30d = num(s30.roi)
    perf.pnl_30d = num(s30.pnl)
    perf.win_rate_30d = num(s30.win_rate)
    perf.max_drawdown_30d = num(s30.mdd)
  }
  if (s90) {
    perf.roi_90d = num(s90.roi)
    perf.pnl = num(s90.pnl)
    perf.win_rate = num(s90.win_rate)
    perf.max_drawdown = num(s90.mdd)
  }
  return perf
}
