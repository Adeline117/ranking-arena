/**
 * Bridge: Convert TraderDetail -> legacy TraderPageData shape.
 * Allows server-side data fetching to use the unified layer without
 * touching the rendering component.
 */

import type { TraderDetail, EquityPoint } from './types'
import { normalizeScoreConfidence } from './mappers'
import { quarantineLegacyPositionHistory } from './history-quarantine'

/**
 * Convert unified TraderDetail to the legacy TraderPageData shape
 * expected by TraderProfileClient.tsx.
 */
export function toTraderPageData(
  detail: TraderDetail,
  options: { publicProfileHistoryQuarantine?: boolean } = {}
): Record<string, unknown> {
  const t = detail.trader
  const p90 = detail.periods['90D']
  const p30 = detail.periods['30D']
  const p7 = detail.periods['7D']
  const publicProfileHistoryQuarantine = options.publicProfileHistoryQuarantine === true
  // Keep the quarantine at the adapter's input boundary as well as its output
  // boundary. This prevents a future public caller from accidentally deriving
  // a raw avg-profit/winning-position field into `performance` before the
  // final response projection strips the original `stats` object.
  const legacyStats = publicProfileHistoryQuarantine ? null : detail.stats
  const legacyEquityCurve = publicProfileHistoryQuarantine
    ? { '90D': [], '30D': [], '7D': [] }
    : detail.equityCurve
  const legacyAssetBreakdown = publicProfileHistoryQuarantine
    ? { '90D': [], '30D': [], '7D': [] }
    : detail.assetBreakdown
  const legacyPortfolio = publicProfileHistoryQuarantine ? [] : detail.portfolio
  const legacyPositionSummary = publicProfileHistoryQuarantine ? null : detail.positionSummary

  // Profile (matches TraderProfile interface)
  const profile = {
    handle: t.handle || t.traderKey,
    id: t.traderKey,
    // Missing source profile counts must remain absent. Treating them as zero
    // makes an unknown public profile field look like a verified count.
    followers: t.followers ?? undefined,
    copiers: t.copiers,
    avatar_url: t.avatarUrl,
    isRegistered: false,
    source: t.platform,
    market_type: t.marketType,
    profile_url: t.profileUrl,
    bio: detail.bio && detail.bio !== 'null' && detail.bio !== 'undefined' ? detail.bio : null,
  }

  // Performance (matches TraderPerformance interface)
  const performance: Record<string, unknown> = {
    has_period_90d: p90 != null,
    roi_90d: p90?.roi ?? t.roi,
    roi_30d: p30?.roi ?? null,
    roi_7d: p7?.roi ?? null,
    pnl: t.pnl,
    pnl_7d: p7?.pnl ?? null,
    pnl_30d: p30?.pnl ?? null,
    win_rate: t.winRate,
    win_rate_7d: p7?.winRate ?? null,
    win_rate_30d: p30?.winRate ?? null,
    max_drawdown: t.maxDrawdown,
    max_drawdown_7d: p7?.maxDrawdown ?? null,
    max_drawdown_30d: p30?.maxDrawdown ?? null,
    trades_count: t.tradesCount,
    arena_score: t.arenaScore,
    arena_score_90d: p90?.arenaScore ?? t.arenaScore,
    arena_score_30d: p30?.arenaScore ?? null,
    arena_score_7d: p7?.arenaScore ?? null,
    // Overall composite score (70/25/5 weighting)
    overall_score: (() => {
      const s90 = p90?.arenaScore ?? t.arenaScore
      const s30 = p30?.arenaScore
      const s7 = p7?.arenaScore
      if (s90 != null) {
        return Number((s90 * 0.7 + (s30 ?? s90) * 0.25 + (s7 ?? s90) * 0.05).toFixed(2))
      }
      return null
    })(),
    return_score: t.returnScore,
    return_score_7d: p7?.returnScore ?? null,
    return_score_30d: p30?.returnScore ?? null,
    pnl_score: t.pnlScore,
    pnl_score_7d: p7?.pnlScore ?? null,
    pnl_score_30d: p30?.pnlScore ?? null,
    drawdown_score: t.drawdownScore,
    drawdown_score_7d: p7?.drawdownScore ?? null,
    stability_score: t.stabilityScore,
    stability_score_7d: p7?.stabilityScore ?? null,
    score_confidence: normalizeScoreConfidence(p90?.scoreConfidence),
    score_confidence_7d: normalizeScoreConfidence(p7?.scoreConfidence),
    score_confidence_30d: normalizeScoreConfidence(p30?.scoreConfidence),
    sharpe_ratio: t.sharpeRatio ?? null,
    sharpe_ratio_30d: p30?.sharpeRatio ?? null,
    sharpe_ratio_7d: p7?.sharpeRatio ?? null,
    winning_positions: (() => {
      // Use enrichment stats, but validate: winning can never exceed total trades
      const enrichWin = legacyStats?.winningPositions
      const _enrichTotal = legacyStats?.totalPositions
      const periodTrades = t.tradesCount
      // If enrichment winning > period trades, enrichment is lifetime data — compute from period instead
      if (enrichWin != null && periodTrades != null && enrichWin > periodTrades) {
        return t.winRate != null && periodTrades > 0
          ? Math.round((t.winRate / 100) * periodTrades)
          : undefined
      }
      return (
        enrichWin ??
        (t.winRate != null && periodTrades != null && periodTrades > 0
          ? Math.round((t.winRate / 100) * periodTrades)
          : undefined)
      )
    })(),
    total_positions: (() => {
      const enrichTotal = legacyStats?.totalPositions
      const periodTrades = t.tradesCount
      // If enrichment total >> period trades, use period trades (more accurate for display period)
      if (enrichTotal != null && periodTrades != null && enrichTotal > periodTrades * 2) {
        return periodTrades > 0 ? periodTrades : undefined
      }
      const raw =
        enrichTotal ?? (periodTrades != null && periodTrades > 0 ? periodTrades : undefined)
      // Cross-validation: total can never be less than winning positions.
      // If mismatch, use period trades as the consistent source for both.
      const winPos =
        legacyStats?.winningPositions ??
        (t.winRate != null && periodTrades != null && periodTrades > 0
          ? Math.round((t.winRate / 100) * periodTrades)
          : undefined)
      if (raw != null && winPos != null && raw < winPos) {
        return periodTrades != null && periodTrades > 0 ? periodTrades : winPos
      }
      return raw
    })(),
    // Per-period winning positions (computed from win_rate * trades_count when not available)
    winning_positions_7d:
      p7?.winRate != null && p7?.tradesCount != null && p7.tradesCount > 0
        ? Math.round((p7.winRate / 100) * p7.tradesCount)
        : undefined,
    winning_positions_30d:
      p30?.winRate != null && p30?.tradesCount != null && p30.tradesCount > 0
        ? Math.round((p30.winRate / 100) * p30.tradesCount)
        : undefined,
    total_positions_7d: p7?.tradesCount ?? undefined,
    total_positions_30d: p30?.tradesCount ?? undefined,
    // Per-period trades count
    trades_count_7d: p7?.tradesCount ?? undefined,
    trades_count_30d: p30?.tradesCount ?? undefined,
    score_penalty: 0,
    // Advanced metrics
    sortinoRatio: t.sortinoRatio ?? null,
    calmarRatio: t.calmarRatio ?? null,
    profitFactor: t.profitFactor ?? null,
    profitability_score: t.profitabilityScore ?? null,
    risk_control_score: t.riskControlScore ?? null,
    execution_score: t.executionScore ?? null,
    // Trading style classification
    tradingStyle: t.tradingStyle ?? null,
    // Avg holding time
    avg_holding_time_hours: t.avgHoldingHours ?? legacyStats?.avgHoldingHours ?? null,
    // Largest win/loss
    largest_win: legacyStats?.largestWin ?? null,
    largest_loss: legacyStats?.largestLoss ?? null,
    // Avg profit/loss for risk/reward ratio
    avg_profit: legacyStats?.avgProfit ?? null,
    avg_loss: legacyStats?.avgLoss ?? null,
  }

  // Stats (matches TraderStats interface)
  const stats: Record<string, unknown> = {
    additionalStats: {
      tradesCount: t.tradesCount,
      avgProfit: legacyStats?.avgProfit ?? null,
      avgLoss: legacyStats?.avgLoss ?? null,
      activeSince: detail.trackedSince
        ? new Date(detail.trackedSince).toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
        : null,
      maxDrawdown: t.maxDrawdown,
      sharpeRatio: t.sharpeRatio,
      avgHoldingTime: (() => {
        const hours = t.avgHoldingHours ?? legacyStats?.avgHoldingHours
        if (hours == null) return null
        if (hours < 1) return `${Math.round(hours * 60)}m`
        if (hours < 24) return `${hours.toFixed(1)}h`
        if (hours < 168) return `${(hours / 24).toFixed(1)}d`
        return `${(hours / 168).toFixed(1)}w`
      })(),
    },
    trading: {
      totalTrades12M: t.tradesCount,
      avgProfit: legacyStats?.avgProfit ?? null,
      avgLoss: legacyStats?.avgLoss ?? null,
      profitableTradesPct: t.winRate,
      winningPositions:
        legacyStats?.winningPositions ??
        (t.winRate != null && t.tradesCount != null && t.tradesCount > 0
          ? Math.round((t.winRate / 100) * t.tradesCount)
          : null),
      totalPositions:
        legacyStats?.totalPositions ??
        (t.tradesCount != null && t.tradesCount > 0 ? t.tradesCount : null),
    },
    frequentlyTraded:
      legacyAssetBreakdown['90D']?.map((a) => ({
        symbol: a.symbol,
        weightPct: a.weightPct,
        count: 0,
        avgProfit: 0,
        avgLoss: 0,
        profitablePct: 0,
      })) ?? [],
  }

  // Equity curve
  const mapEC = (points: EquityPoint[]) =>
    points.flatMap((p) => {
      // The legacy chart contract requires both fields to be finite numbers.
      // Omitting an incomplete point is the only type-safe way to keep unknown
      // values away from consumers that perform arithmetic on both columns.
      // In particular, never turn a missing value into a measured zero.
      if (
        typeof p.roi !== 'number' ||
        !Number.isFinite(p.roi) ||
        typeof p.pnl !== 'number' ||
        !Number.isFinite(p.pnl)
      ) {
        return []
      }
      return [{ date: p.date, roi: p.roi, pnl: p.pnl }]
    })
  const equityCurve = {
    '90D': mapEC(legacyEquityCurve['90D'] || []),
    '30D': mapEC(legacyEquityCurve['30D'] || []),
    '7D': mapEC(legacyEquityCurve['7D'] || []),
  }

  // Asset breakdown
  const assetBreakdown = {
    '90D':
      legacyAssetBreakdown['90D']?.map((a) => ({ symbol: a.symbol, weightPct: a.weightPct })) ?? [],
    '30D':
      legacyAssetBreakdown['30D']?.map((a) => ({ symbol: a.symbol, weightPct: a.weightPct })) ?? [],
    '7D':
      legacyAssetBreakdown['7D']?.map((a) => ({ symbol: a.symbol, weightPct: a.weightPct })) ?? [],
  }

  // Similar traders
  const similarTraders = detail.similarTraders.map((st) => ({
    handle: st.handle || st.traderKey,
    id: st.traderKey,
    followers: st.followers ?? undefined,
    avatar_url: st.avatarUrl,
    source: st.platform,
    roi_90d: st.roi,
    arena_score: st.arenaScore,
  }))

  // Portfolio
  const portfolio = legacyPortfolio.map((p) => ({
    market: p.symbol,
    direction: p.direction || 'long',
    invested: 0,
    pnl: p.pnlUsd ?? 0,
    value: 0,
    price: p.entryPrice ?? 0,
  }))

  // Never bridge legacy closed-position rows into a response. This adapter has
  // no terminal acquisition evidence and must not coerce unknown prices/PnL to
  // measured zeroes. Evidence-bound records use the arena serving contract.
  const positionHistory: never[] = []

  const pageData = {
    profile,
    performance,
    rank: t.rank ?? null,
    source_trader_id: t.traderKey,
    stats: legacyStats ? stats : null,
    portfolio,
    positionHistory,
    similarTraders,
    equityCurve,
    assetBreakdown,
    positionSummary: legacyPositionSummary ?? null,
    trackedSince: detail.trackedSince,
    lastUpdated: t.lastUpdated ?? null,
  }

  // Keep compare's existing legacy adapter contract outside this containment
  // scope. Public profile callers opt in so a future enrichment change cannot
  // accidentally reintroduce curve/portfolio/price/PnL fields after mapping.
  return publicProfileHistoryQuarantine
    ? (quarantineLegacyPositionHistory(pageData) as Record<string, unknown>)
    : pageData
}
