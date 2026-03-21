/**
 * Polymarket Enrichment
 *
 * Polymarket provides public APIs for:
 * 1. Leaderboard: GET /v1/leaderboard?timePeriod={period}&user={wallet}
 *    - PnL and volume per period
 * 2. Positions: GET /positions?user={wallet}
 *    - Current open positions with PnL
 * 3. Closed positions: GET /closed-positions?user={wallet}
 *    - Historical closed positions with realized PnL
 * 4. Portfolio value: GET /value?user={wallet}
 *
 * Notes:
 * - No auth required
 * - trader_key = proxy wallet address (0x...)
 * - Prediction market — positions are event outcomes, not trading pairs
 */

import type { EquityCurvePoint, StatsDetail, PortfolioPosition, PositionHistoryItem } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const DATA_API = 'https://data-api.polymarket.com'

/**
 * Polymarket has no equity curve API — return empty.
 * Equity curves will be built from daily snapshot diffs.
 */
export async function fetchPolymarketEquityCurve(
  _traderId: string,
  _days: number
): Promise<EquityCurvePoint[]> {
  return []
}

/**
 * Fetch stats detail for a Polymarket trader.
 * Combines leaderboard data (PnL, volume) with position counts.
 */
export async function fetchPolymarketStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Fetch ALL-time leaderboard entry for this user
    const [lbAll, lbMonth, positions, closedPositions] = await Promise.all([
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/v1/leaderboard?timePeriod=ALL&user=${traderId}&limit=1`,
        { timeoutMs: 10000 }
      ).catch(() => null),
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/v1/leaderboard?timePeriod=MONTH&user=${traderId}&limit=1`,
        { timeoutMs: 10000 }
      ).catch(() => null),
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/positions?user=${traderId}&limit=500`,
        { timeoutMs: 10000 }
      ).catch(() => null),
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/closed-positions?user=${traderId}&limit=500`,
        { timeoutMs: 10000 }
      ).catch(() => null),
    ])

    const entry = Array.isArray(lbAll) && lbAll.length > 0 ? lbAll[0] : null
    const monthEntry = Array.isArray(lbMonth) && lbMonth.length > 0 ? lbMonth[0] : null
    const openPositions = Array.isArray(positions) ? positions : []
    const closedPos = Array.isArray(closedPositions) ? closedPositions : []

    const pnl = entry ? num(entry.pnl) : null
    const volume = entry ? num(entry.vol) : null
    const totalPositions = openPositions.length + closedPos.length

    // Compute win rate from closed positions
    let wins = 0
    let totalClosed = 0
    for (const pos of closedPos) {
      const realizedPnl = num(pos.realizedPnl)
      if (realizedPnl != null) {
        totalClosed++
        if (realizedPnl > 0) wins++
      }
    }
    const profitableTradesPct = totalClosed > 0
      ? Math.round((wins / totalClosed) * 1000) / 10
      : null

    // Compute ROI from PnL / volume
    let roi: number | null = null
    if (pnl != null && volume != null && volume > 0) {
      roi = Math.round((pnl / volume) * 100 * 100) / 100
      roi = Math.max(-500, Math.min(10000, roi))
    }

    // AUM from current positions
    let aum: number | null = null
    for (const pos of openPositions) {
      const currentValue = num(pos.currentValue)
      if (currentValue != null) {
        aum = (aum || 0) + currentValue
      }
    }

    return {
      totalTrades: totalClosed > 0 ? totalClosed : null,
      profitableTradesPct,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: null,
      currentDrawdown: null,
      volatility: null,
      roi,
      pnl,
      copiersCount: null,
      copiersPnl: null,
      aum: aum != null ? Math.round(aum * 100) / 100 : null,
      winningPositions: wins > 0 ? wins : null,
      totalPositions: totalPositions > 0 ? totalPositions : null,
    }
  } catch (err) {
    logger.warn(`[polymarket] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Fetch current open positions from Polymarket.
 */
export async function fetchPolymarketCurrentPositions(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const data = await fetchJson<Array<Record<string, unknown>>>(
      `${DATA_API}/positions?user=${traderId}&limit=100&sizeThreshold=1`,
      { timeoutMs: 10000 }
    )

    if (!Array.isArray(data) || data.length === 0) return []

    return data.map((pos) => ({
      symbol: String(pos.title || pos.slug || `Market#${pos.conditionId}`).slice(0, 60),
      direction: String(pos.outcome || 'Yes').toLowerCase() === 'no' ? 'short' as const : 'long' as const,
      investedPct: num(pos.initialValue) != null && num(pos.currentValue) != null
        ? null // Can't derive percentage without total portfolio
        : null,
      entryPrice: num(pos.avgPrice),
      pnl: num(pos.cashPnl),
    }))
  } catch (err) {
    logger.warn(`[polymarket] Positions failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch closed position history from Polymarket.
 */
export async function fetchPolymarketPositionHistory(
  traderId: string
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchJson<Array<Record<string, unknown>>>(
      `${DATA_API}/closed-positions?user=${traderId}&limit=100&sortBy=REALIZEDPNL`,
      { timeoutMs: 10000 }
    )

    if (!Array.isArray(data) || data.length === 0) return []

    return data.map((pos) => ({
      symbol: String(pos.title || pos.slug || `Market#${pos.conditionId}`).slice(0, 60),
      direction: String(pos.outcome || 'Yes').toLowerCase() === 'no' ? 'short' as const : 'long' as const,
      positionType: 'prediction',
      marginMode: 'isolated',
      openTime: null,
      closeTime: pos.timestamp ? String(pos.timestamp) : null,
      entryPrice: num(pos.avgPrice),
      exitPrice: num(pos.curPrice),
      maxPositionSize: num(pos.totalBought),
      closedSize: null,
      pnlUsd: num(pos.realizedPnl),
      pnlPct: null,
      status: 'closed',
    }))
  } catch (err) {
    logger.warn(`[polymarket] Position history failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function num(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}
