/**
 * Bridge: Convert TraderDetail -> legacy TraderPageData shape.
 * Allows server-side data fetching to use the unified layer without
 * touching the rendering component.
 */

import type { TraderDetail, EquityPoint } from './types'

/**
 * Convert unified TraderDetail to the legacy TraderPageData shape
 * expected by TraderProfileClient.tsx.
 */
export function toTraderPageData(detail: TraderDetail): Record<string, unknown> {
  const t = detail.trader
  const p90 = detail.periods['90D']
  const p30 = detail.periods['30D']
  const p7 = detail.periods['7D']

  // Profile (matches TraderProfile interface)
  const profile = {
    handle: t.handle || t.traderKey,
    id: t.traderKey,
    followers: t.followers ?? 0,
    copiers: t.copiers,
    avatar_url: t.avatarUrl,
    isRegistered: false,
    source: t.platform,
    market_type: t.marketType,
    profile_url: t.profileUrl,
    bio: (detail.bio && detail.bio !== 'null' && detail.bio !== 'undefined') ? detail.bio : null,
  }

  // Performance (matches TraderPerformance interface)
  const performance: Record<string, unknown> = {
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
        return Number(((s90 * 0.70) + ((s30 ?? s90) * 0.25) + ((s7 ?? s90) * 0.05)).toFixed(2))
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
    score_confidence: t.scoreConfidence || 'full',
    sharpe_ratio: t.sharpeRatio ?? null,
    sharpe_ratio_30d: p30?.sharpeRatio ?? null,
    sharpe_ratio_7d: p7?.sharpeRatio ?? null,
    winning_positions: detail.stats?.winningPositions ?? (
      t.winRate != null && t.tradesCount != null && t.tradesCount > 0
        ? Math.round((t.winRate / 100) * t.tradesCount)
        : undefined
    ),
    total_positions: detail.stats?.totalPositions ?? (
      t.tradesCount != null && t.tradesCount > 0 ? t.tradesCount : undefined
    ),
    // Per-period winning positions (computed from win_rate * trades_count when not available)
    winning_positions_7d: p7?.winRate != null && p7?.tradesCount != null && p7.tradesCount > 0
      ? Math.round((p7.winRate / 100) * p7.tradesCount) : undefined,
    winning_positions_30d: p30?.winRate != null && p30?.tradesCount != null && p30.tradesCount > 0
      ? Math.round((p30.winRate / 100) * p30.tradesCount) : undefined,
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
    avg_holding_time_hours: t.avgHoldingHours ?? detail.stats?.avgHoldingHours ?? null,
    // Largest win/loss
    largest_win: detail.stats?.largestWin ?? null,
    largest_loss: detail.stats?.largestLoss ?? null,
    // Avg profit/loss for risk/reward ratio
    avg_profit: detail.stats?.avgProfit ?? null,
    avg_loss: detail.stats?.avgLoss ?? null,
  }

  // Stats (matches TraderStats interface)
  const stats: Record<string, unknown> = {
    additionalStats: {
      tradesCount: t.tradesCount,
      avgProfit: detail.stats?.avgProfit ?? null,
      avgLoss: detail.stats?.avgLoss ?? null,
      activeSince: detail.trackedSince
        ? new Date(detail.trackedSince).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
        : null,
      maxDrawdown: t.maxDrawdown,
      sharpeRatio: t.sharpeRatio,
      avgHoldingTime: (() => {
        const hours = t.avgHoldingHours ?? detail.stats?.avgHoldingHours
        if (hours == null) return null
        if (hours < 1) return `${Math.round(hours * 60)}m`
        if (hours < 24) return `${hours.toFixed(1)}h`
        if (hours < 168) return `${(hours / 24).toFixed(1)}d`
        return `${(hours / 168).toFixed(1)}w`
      })(),
    },
    trading: {
      totalTrades12M: t.tradesCount,
      avgProfit: detail.stats?.avgProfit ?? null,
      avgLoss: detail.stats?.avgLoss ?? null,
      profitableTradesPct: t.winRate,
      winningPositions: detail.stats?.winningPositions ?? (
        t.winRate != null && t.tradesCount != null && t.tradesCount > 0
          ? Math.round((t.winRate / 100) * t.tradesCount) : null
      ),
      totalPositions: detail.stats?.totalPositions ?? (
        t.tradesCount != null && t.tradesCount > 0 ? t.tradesCount : null
      ),
    },
    frequentlyTraded: detail.assetBreakdown['90D']?.map(a => ({
      symbol: a.symbol,
      weightPct: a.weightPct,
      count: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitablePct: 0,
    })) ?? [],
  }

  // Equity curve
  const mapEC = (points: EquityPoint[]) => points.map(p => ({
    date: p.date,
    roi: p.roi ?? 0,
    pnl: p.pnl ?? 0,
  }))
  const equityCurve = {
    '90D': mapEC(detail.equityCurve['90D'] || []),
    '30D': mapEC(detail.equityCurve['30D'] || []),
    '7D': mapEC(detail.equityCurve['7D'] || []),
  }

  // Asset breakdown
  const assetBreakdown = {
    '90D': detail.assetBreakdown['90D']?.map(a => ({ symbol: a.symbol, weightPct: a.weightPct })) ?? [],
    '30D': detail.assetBreakdown['30D']?.map(a => ({ symbol: a.symbol, weightPct: a.weightPct })) ?? [],
    '7D': detail.assetBreakdown['7D']?.map(a => ({ symbol: a.symbol, weightPct: a.weightPct })) ?? [],
  }

  // Similar traders
  const similarTraders = detail.similarTraders.map(st => ({
    handle: st.handle || st.traderKey,
    id: st.traderKey,
    followers: st.followers ?? 0,
    avatar_url: st.avatarUrl,
    source: st.platform,
    roi_90d: st.roi,
    arena_score: st.arenaScore,
  }))

  // Portfolio
  const portfolio = detail.portfolio.map(p => ({
    market: p.symbol,
    direction: p.direction || 'long',
    invested: 0,
    pnl: p.pnlUsd ?? 0,
    value: 0,
    price: p.entryPrice ?? 0,
  }))

  // Position history
  const positionHistory = detail.positionHistory.map(p => ({
    symbol: p.symbol,
    direction: p.direction || 'long',
    positionType: '',
    marginMode: '',
    openTime: p.openTime || '',
    closeTime: p.closeTime || '',
    entryPrice: p.entryPrice ?? 0,
    exitPrice: p.exitPrice ?? 0,
    maxPositionSize: 0,
    closedSize: 0,
    pnlUsd: p.pnlUsd ?? 0,
    pnlPct: p.pnlPct ?? 0,
    status: p.status || 'closed',
  }))

  return {
    profile,
    performance,
    stats: detail.stats ? stats : null,
    portfolio,
    positionHistory,
    similarTraders,
    equityCurve,
    assetBreakdown,
    trackedSince: detail.trackedSince,
  }
}
