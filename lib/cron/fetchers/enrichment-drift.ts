/**
 * Drift Protocol Enrichment
 *
 * Uses the public data.api.drift.trade API:
 * - /fills/{authority} — trade fills for position history
 * - /stats/leaderboard — PnL history for equity curves
 *
 * No auth required. Rate limiting: conservative 500ms delays.
 */

import type { PositionHistoryItem, StatsDetail } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const DATA_API = 'https://data.api.drift.trade'

interface DriftFill {
  marketIndex?: number
  marketType?: string
  baseAssetAmount?: number
  quoteAssetAmount?: number
  ts?: number
  action?: string
  taker?: string
  maker?: string
  takerOrderDirection?: string
  fillerReward?: number
}

interface DriftUserStats {
  authority?: string
  pnl?: number
  volume?: number
  fees?: number
}

/**
 * Fetch position history from Drift fill data.
 */
export async function fetchDriftPositionHistory(
  authority: string,
  limit = 100
): Promise<PositionHistoryItem[]> {
  try {
    const url = `${DATA_API}/fills/${authority}?limit=${limit}`
    const fills = await fetchJson<DriftFill[]>(url, { timeoutMs: 15000 })

    if (!Array.isArray(fills) || fills.length === 0) return []

    return fills
      .filter((f) => f.baseAssetAmount && f.quoteAssetAmount)
      .slice(0, limit)
      .map((f) => {
        const isLong = (f.takerOrderDirection || '').toLowerCase() === 'long'
        const size = Math.abs(f.baseAssetAmount || 0) / 1e9
        const quote = Math.abs(f.quoteAssetAmount || 0) / 1e6
        const price = size > 0 ? quote / size : null

        return {
          symbol: `PERP-${f.marketIndex ?? '?'}`,
          direction: isLong ? 'long' as const : 'short' as const,
          positionType: 'perpetual',
          marginMode: 'cross',
          openTime: null,
          closeTime: f.ts ? new Date(f.ts * 1000).toISOString() : null,
          entryPrice: null,
          exitPrice: price,
          maxPositionSize: null,
          closedSize: size > 0 ? size : null,
          pnlUsd: null,
          pnlPct: null,
          status: 'closed',
        }
      })
  } catch (err) {
    logger.warn(`[drift] Position history failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch stats detail for a Drift trader from the user stats endpoint.
 */
export async function fetchDriftStatsDetail(
  authority: string
): Promise<StatsDetail | null> {
  try {
    const url = `${DATA_API}/stats/user/${authority}`
    const stats = await fetchJson<DriftUserStats>(url, { timeoutMs: 10000 })

    if (!stats) return null

    return {
      totalTrades: null,
      profitableTradesPct: null,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: null,
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[drift] Stats detail failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
