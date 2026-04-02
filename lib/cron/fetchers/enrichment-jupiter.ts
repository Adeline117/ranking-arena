/**
 * Jupiter Perps Enrichment Module
 *
 * Uses the public Jupiter Perps API:
 * - /v1/trades?walletAddress={addr} — trade history with PnL
 *
 * Builds equity curves and position history from trade data.
 * Also computes trading stats (win rate, avg profit/loss, max drawdown).
 */

import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'
import { buildEquityCurveFromPositions, computeStatsFromPositions } from './enrichment-dex'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const TRADES_API = 'https://perps-api.jup.ag/v1/trades'

interface JupiterTrade {
  action: string // 'Increase' | 'Decrease' | 'Liquidation' | 'ClosePosition'
  pnl: string | null
  pnlPercentage: string | null
  size: string
  price: string | null
  fee: string
  createdTime: number
  side: string // 'Long' | 'Short'
  marketSymbol: string | null
  token: string | null
}

interface JupiterTradesResponse {
  dataList: JupiterTrade[]
  count: number
}

/**
 * Fetch position history from Jupiter /v1/trades endpoint.
 * Filters to closing trades (Decrease, ClosePosition, Liquidation) that have PnL.
 */
export async function fetchJupiterPositionHistory(
  walletAddress: string,
  limit = 200
): Promise<PositionHistoryItem[]> {
  try {
    const url = `${TRADES_API}?walletAddress=${walletAddress}&limit=${limit}`
    const data = await fetchJson<JupiterTradesResponse>(url, { timeoutMs: 15000 })

    if (!data?.dataList || data.dataList.length === 0) return []

    // Only closing trades with PnL
    const closingTrades = data.dataList.filter(
      (t) => t.pnl != null && t.action !== 'Increase'
    )

    return closingTrades.map((t) => {
      const pnl = parseFloat(t.pnl || '0')
      const pnlPct = t.pnlPercentage ? parseFloat(t.pnlPercentage) : null
      const size = parseFloat(t.size || '0') / 1e6 // Jupiter amounts in 6 decimals
      const price = t.price ? parseFloat(t.price) / 1e6 : null
      const isLong = (t.side || '').toLowerCase() === 'long'
      const symbol = t.marketSymbol || t.token || 'JUP'

      return {
        symbol,
        direction: isLong ? 'long' as const : 'short' as const,
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: null,
        closeTime: t.createdTime ? new Date(t.createdTime * 1000).toISOString() : null,
        entryPrice: null,
        exitPrice: price,
        maxPositionSize: size > 0 ? size : null,
        closedSize: size > 0 ? size : null,
        pnlUsd: pnl / 1e6, // Jupiter PnL in 6 decimals
        pnlPct,
        status: t.action === 'Liquidation' ? 'liquidated' : 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[jupiter] Position history failed for ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Build equity curve from Jupiter trade history.
 */
export async function fetchJupiterEquityCurve(
  walletAddress: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const positions = await fetchJupiterPositionHistory(walletAddress, 500)
    if (positions.length === 0) return []
    return buildEquityCurveFromPositions(positions, days)
  } catch (err) {
    logger.warn(`[jupiter] Equity curve failed for ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Compute stats from Jupiter trade history.
 */
export async function fetchJupiterStatsDetail(
  walletAddress: string
): Promise<StatsDetail | null> {
  try {
    const positions = await fetchJupiterPositionHistory(walletAddress, 500)
    if (positions.length === 0) return null

    const derivedStats = computeStatsFromPositions(positions)

    return {
      totalTrades: derivedStats.totalTrades ?? null,
      profitableTradesPct: derivedStats.profitableTradesPct ?? null,
      avgHoldingTimeHours: null,
      avgProfit: derivedStats.avgProfit ?? null,
      avgLoss: derivedStats.avgLoss ?? null,
      largestWin: derivedStats.largestWin ?? null,
      largestLoss: derivedStats.largestLoss ?? null,
      sharpeRatio: derivedStats.sharpeRatio ?? null,
      maxDrawdown: derivedStats.maxDrawdown ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: null,
      winningPositions: derivedStats.winningPositions ?? null,
      totalPositions: derivedStats.totalPositions ?? null,
    }
  } catch (err) {
    logger.warn(`[jupiter] Stats detail failed for ${walletAddress}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
