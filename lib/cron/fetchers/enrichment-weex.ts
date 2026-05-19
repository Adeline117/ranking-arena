/**
 * WEEX enrichment — stats from public copy-trade API
 *
 * WEEX provides per-trader stats via:
 *   GET https://www.weex.com/api/v1/copy-trade/public/trader/{uid}/info?period={7d|30d}
 *
 * Returns: roi, pnl, winRate, maxDrawdown, followers, copiers
 * Missing: sharpe_ratio (computed from daily snapshots by enrichment-runner)
 *
 * Note: WEEX does NOT support 90d period — enrichment uses 30d data.
 * Equity curve: not available from API → fallback to daily snapshots.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { StatsDetail } from './enrichment-types'

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

/**
 * Fetch stats from WEEX public API.
 * Uses 30d period (longest available).
 */
export async function fetchWeexStatsDetail(traderId: string): Promise<StatsDetail | null> {
  try {
    const response = await fetchJson<Record<string, unknown>>(
      `https://www.weex.com/api/v1/copy-trade/public/trader/${traderId}/info?period=30d`,
      { timeoutMs: 10000 }
    )

    const data = (response?.data ?? response) as Record<string, unknown> | null
    if (!data) return null

    const winRate = safeNum(data.winRate)
    const maxDrawdown = safeNum(data.maxDrawdown)

    return {
      totalTrades: null,
      profitableTradesPct:
        winRate != null ? (Math.abs(winRate) <= 1 ? winRate * 100 : winRate) : null,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null, // Cannot compute: WEEX API has no Sharpe or equity curve; derived from daily snapshots by enrichment-runner
      maxDrawdown:
        maxDrawdown != null ? Math.abs(maxDrawdown <= 1 ? maxDrawdown * 100 : maxDrawdown) : null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: safeNum(data.copiers ?? data.followCount),
      copiersPnl: null,
      aum: null,
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] WEEX stats detail failed for ${traderId}: ${err}`)
    return null
  }
}
