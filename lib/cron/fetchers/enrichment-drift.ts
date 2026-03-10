/**
 * Drift Protocol Enrichment
 *
 * Uses the public data.api.drift.trade API:
 * - /fills/{authority} — trade fills for position history
 * - /stats/user/{authority} — user stats
 *
 * Computes equity curve + trading stats from fills data.
 * No auth required. Rate limiting: conservative 500ms delays.
 */

import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'
import { computeStatsFromPositions, buildEquityCurveFromPositions } from './enrichment-dex'
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
  quoteAssetAmountFilled?: number
  baseAssetAmountFilled?: number
  pnl?: number
}

interface DriftUserStats {
  authority?: string
  pnl?: number
  volume?: number
  fees?: number
}

// Market index to symbol mapping (common Drift perp markets)
const DRIFT_MARKETS: Record<number, string> = {
  0: 'SOL', 1: 'BTC', 2: 'ETH', 3: 'APT', 4: 'BONK',
  5: 'MATIC', 6: 'ARB', 7: 'DOGE', 8: 'BNB', 9: 'SUI',
  10: 'PEPE', 11: '1KPEPE', 12: 'OP', 13: 'RNDR', 14: 'XRP',
  15: 'HNT', 16: 'INJ', 17: 'LINK', 18: 'RLB', 19: 'PYTH',
  20: 'TIA', 21: 'JTO', 22: 'SEI', 23: 'AVAX', 24: 'WIF',
  25: 'JUP', 26: 'DYM', 27: 'TAO', 28: 'W', 29: 'KMNO',
  30: 'TNSR', 31: 'DRIFT',
}

/**
 * Fetch position history from Drift fill data.
 * Enhanced: includes PnL and proper symbol names.
 */
export async function fetchDriftPositionHistory(
  authority: string,
  limit = 200
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
        const size = Math.abs(f.baseAssetAmount || f.baseAssetAmountFilled || 0) / 1e9
        const quote = Math.abs(f.quoteAssetAmount || f.quoteAssetAmountFilled || 0) / 1e6
        const price = size > 0 ? quote / size : null
        const symbol = DRIFT_MARKETS[f.marketIndex ?? -1] || `PERP-${f.marketIndex ?? '?'}`
        const pnl = f.pnl != null ? f.pnl / 1e6 : null

        return {
          symbol,
          direction: isLong ? 'long' as const : 'short' as const,
          positionType: 'perpetual',
          marginMode: 'cross',
          openTime: null,
          closeTime: f.ts ? new Date(f.ts * 1000).toISOString() : null,
          entryPrice: null,
          exitPrice: price,
          maxPositionSize: quote > 0 ? quote : null,
          closedSize: size > 0 ? size : null,
          pnlUsd: pnl,
          pnlPct: quote > 0 && pnl != null ? (pnl / quote) * 100 : null,
          status: 'closed',
        }
      })
  } catch (err) {
    logger.warn(`[drift] Position history failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Build Drift equity curve from fill history.
 */
export async function fetchDriftEquityCurve(
  authority: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const positions = await fetchDriftPositionHistory(authority, 500)
    if (positions.length === 0) return []
    return buildEquityCurveFromPositions(positions, days)
  } catch (err) {
    logger.warn(`[drift] Equity curve failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch stats detail for a Drift trader.
 * Combines user stats API with computed metrics from fills.
 */
export async function fetchDriftStatsDetail(
  authority: string
): Promise<StatsDetail | null> {
  try {
    // Fetch user stats and fills in parallel
    const [stats, positions] = await Promise.all([
      fetchJson<DriftUserStats>(`${DATA_API}/stats/user/${authority}`, { timeoutMs: 10000 })
        .catch(() => null),
      fetchDriftPositionHistory(authority, 500),
    ])

    const derivedStats = computeStatsFromPositions(positions)

    return {
      totalTrades: derivedStats.totalTrades ?? null,
      profitableTradesPct: derivedStats.profitableTradesPct ?? null,
      avgHoldingTimeHours: null,
      avgProfit: derivedStats.avgProfit ?? null,
      avgLoss: derivedStats.avgLoss ?? null,
      largestWin: derivedStats.largestWin ?? null,
      largestLoss: derivedStats.largestLoss ?? null,
      sharpeRatio: null, // Computed from equity curve
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
    logger.warn(`[drift] Stats detail failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
