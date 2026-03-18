/**
 * Phemex enrichment: stats detail from copy-trading public API
 *
 * API: GET https://api.phemex.com/copy-trading/public/trader/{uid}/detail?period=90d
 * - Public, no auth required
 * - Returns: roi, pnl, winRate, maxDrawdown, followers, copiers
 * - winRate and maxDrawdown are decimals (0-1), need ×100
 *
 * Equity curve: not available via public API -> fallback to daily snapshots.
 * Position history: not available via public API.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

// ============================================
// Equity Curve
// ============================================

/**
 * Phemex doesn't provide per-trader equity curve/chart API.
 * Returns empty — enrichment-runner fallback to daily snapshots.
 */
export async function fetchPhemexEquityCurve(
  _traderId: string,
  _days: number = 90
): Promise<EquityCurvePoint[]> {
  return []
}

// ============================================
// Stats Detail
// ============================================

interface PhemexTraderDetail {
  uid?: string
  nickname?: string
  roi?: number
  pnl?: number
  winRate?: number       // decimal 0-1
  maxDrawdown?: number   // decimal 0-1
  followers?: number
  copiers?: number
  totalTrades?: number
  tradeCnt?: number
  avatar?: string
}

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

/**
 * Fetch stats from Phemex copy-trading public trader detail.
 * Provides win_rate, max_drawdown, followers, copiers.
 */
export async function fetchPhemexStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const response = await fetchJson<{ data?: PhemexTraderDetail }>(
      `https://api.phemex.com/copy-trading/public/trader/${traderId}/detail?period=90d`,
      { timeoutMs: 10000 }
    )

    const info = response?.data
    if (!info) return null

    // winRate: decimal 0-1 → percentage
    const rawWr = safeNum(info.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null

    // maxDrawdown: decimal 0-1 → absolute percentage
    const rawMdd = safeNum(info.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    const totalTrades = safeNum(info.totalTrades ?? info.tradeCnt)

    return {
      totalTrades: totalTrades != null ? Math.round(totalTrades) : null,
      profitableTradesPct: winRate,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: safeNum(info.copiers),
      copiersPnl: null,
      aum: null,
      winningPositions: null,
      totalPositions: totalTrades != null ? Math.round(totalTrades) : null,
    }
  } catch (err) {
    logger.warn(`[enrichment] Phemex stats detail failed for ${traderId}: ${err}`)
    return null
  }
}
