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
 * Drift snapshots API response item.
 * The snapshots/trading endpoint returns daily snapshots with cumulative PnL.
 */
interface DriftSnapshot {
  epochTs?: number
  cumulativeRealizedPnl?: number
  cumulativePerpPnl?: number
  allTimeTotalPnl?: number
}

/**
 * Fetch Drift equity curve from snapshots API (preferred — gives daily PnL curve).
 * Fallback: build from fill history.
 */
export async function fetchDriftEquityCurve(
  authority: string,
  days: number
): Promise<EquityCurvePoint[]> {
  // Hard timeout protection: 2 minutes max per trader
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchDriftEquityCurve exceeded 2 minutes')), 120000)
  )

  const mainWork = async (): Promise<EquityCurvePoint[]> => {
    try {
      // Strategy 1: Use snapshots/trading API for accurate daily equity curve
      try {
        const snapUrl = `${DATA_API}/authority/${authority}/snapshots/trading?days=${days}`
        const snapshots = await fetchJson<DriftSnapshot[]>(snapUrl, { timeoutMs: 15000 })

        if (Array.isArray(snapshots) && snapshots.length >= 2) {
          const points: EquityCurvePoint[] = snapshots
            .filter((s) => s.epochTs != null)
            .map((s) => {
              const pnl = s.cumulativeRealizedPnl ?? s.allTimeTotalPnl ?? s.cumulativePerpPnl ?? 0
              // Drift values are in USDC base units (divide by 1e6)
              const pnlUsd = Math.abs(pnl) > 1e10 ? pnl / 1e6 : pnl
              return {
                date: new Date((s.epochTs ?? 0) * 1000).toISOString().split('T')[0],
                roi: 0,
                pnl: pnlUsd,
              }
            })
            .sort((a, b) => a.date.localeCompare(b.date))

          // Deduplicate by date (keep last per day)
          const dateMap = new Map<string, EquityCurvePoint>()
          for (const p of points) dateMap.set(p.date, p)
          const deduped = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date))

          if (deduped.length >= 2) {
            // Compute ROI relative to first point
            const basePnl = deduped[0].pnl ?? 0
            const estimatedCapital = Math.abs(basePnl) > 0 ? Math.abs(basePnl) * 5 : 10000
            for (const p of deduped) {
              p.roi = (((p.pnl ?? 0) - basePnl) / estimatedCapital) * 100
            }
            return deduped
          }
        }
      } catch (err) {
        logger.warn(`[drift] Snapshots API failed for ${authority}, falling back to fills: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Strategy 2: Fallback to building from fill history
      const positions = await fetchDriftPositionHistory(authority, 500)
      if (positions.length === 0) return []
      return buildEquityCurveFromPositions(positions, days)
    } catch (err) {
      logger.warn(`[drift] Equity curve failed for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  try {
    return await Promise.race([mainWork(), timeoutPromise])
  } catch (err) {
    logger.warn(`[drift] Equity curve timeout for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
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
  // Hard timeout protection: 2 minutes max per trader
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchDriftStatsDetail exceeded 2 minutes')), 120000)
  )

  const mainWork = async (): Promise<StatsDetail | null> => {
    try {
      // Fetch user stats and fills in parallel (with error tolerance)
      const results = await Promise.allSettled([
        fetchJson<DriftUserStats>(`${DATA_API}/stats/user/${authority}`, { timeoutMs: 10000 })
          .catch(() => null),
        fetchDriftPositionHistory(authority, 500),
      ])
      
      const stats = results[0].status === 'fulfilled' ? results[0].value : null
      const positions = results[1].status === 'fulfilled' ? results[1].value : []
      
      if (results[0].status === 'rejected') {
        console.error(`Drift stats fetch failed for ${authority}:`, results[0].reason)
      }
      if (results[1].status === 'rejected') {
        console.error(`Drift positions fetch failed for ${authority}:`, results[1].reason)
      }

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

  try {
    return await Promise.race([mainWork(), timeoutPromise])
  } catch (err) {
    logger.warn(`[drift] Stats detail timeout for ${authority}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
