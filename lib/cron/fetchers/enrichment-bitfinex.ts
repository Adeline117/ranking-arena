/**
 * Bitfinex enrichment: equity curve + stats detail
 *
 * Bitfinex has a public rankings API (no auth) with multiple ranking keys:
 * - plu_diff: PnL change in USD (per period)
 * - plr: PnL ratio ranking
 * - plu: Inception unrealized profit (equity proxy)
 *
 * Strategy:
 * - Equity curve: not directly available per-trader (rankings only)
 *   -> Fall back to buildEquityCurveFromSnapshots in enrichment-runner
 * - Stats detail: compute win_rate and MDD from pnlRatios if available,
 *   otherwise use platform-level data from rankings
 *
 * Since Bitfinex only provides aggregate ranking data (not per-trader detail),
 * we fetch the full rankings once and cache them, then look up individual traders.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

// ============================================
// Cached rankings for batch lookups
// ============================================

interface BitfinexRankingEntry {
  username: string
  rank: number
  value: number // PnL for plu_diff, ratio for plr
}

interface BitfinexRankingsCache {
  pluDiff7d: Map<string, BitfinexRankingEntry>
  pluDiff1m: Map<string, BitfinexRankingEntry>
  plr7d: Map<string, BitfinexRankingEntry>
  plr1m: Map<string, BitfinexRankingEntry>
  plu1m: Map<string, BitfinexRankingEntry> // equity proxy (inception)
  fetchedAt: number
}

let rankingsCache: BitfinexRankingsCache | null = null
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

type BitfinexRow = [number, unknown, string, number, unknown, unknown, number, ...unknown[]]

async function fetchRankings(key: string, timeframe: string): Promise<Map<string, BitfinexRankingEntry>> {
  const map = new Map<string, BitfinexRankingEntry>()
  try {
    const rows = await fetchJson<BitfinexRow[]>(
      `https://api-pub.bitfinex.com/v2/rankings/${key}:${timeframe}:tGLOBAL:USD/hist`,
      { timeoutMs: 10000 }
    )
    if (!Array.isArray(rows)) return map

    for (const row of rows) {
      if (!Array.isArray(row) || !row[2]) continue
      const username = String(row[2]).toLowerCase()
      map.set(username, {
        username,
        rank: Number(row[3]) || 0,
        value: Number(row[6]) || 0,
      })
    }
  } catch (err) {
    logger.warn(`[enrichment] Bitfinex rankings fetch failed for ${key}:${timeframe}: ${err}`)
  }
  return map
}

async function ensureRankingsCache(): Promise<BitfinexRankingsCache> {
  if (rankingsCache && Date.now() - rankingsCache.fetchedAt < CACHE_TTL_MS) {
    return rankingsCache
  }

  const [pluDiff7d, pluDiff1m, plr7d, plr1m, plu1m] = await Promise.all([
    fetchRankings('plu_diff', '1w'),
    fetchRankings('plu_diff', '1M'),
    fetchRankings('plr', '1w'),
    fetchRankings('plr', '1M'),
    fetchRankings('plu', '1M'),
  ])

  rankingsCache = {
    pluDiff7d,
    pluDiff1m,
    plr7d,
    plr1m,
    plu1m,
    fetchedAt: Date.now(),
  }

  return rankingsCache
}

// ============================================
// Equity Curve
// ============================================

/**
 * Bitfinex doesn't provide per-trader timeseries.
 * Return empty — enrichment-runner will fallback to buildEquityCurveFromSnapshots.
 */
export async function fetchBitfinexEquityCurve(
  _traderId: string,
  _days: number = 90
): Promise<EquityCurvePoint[]> {
  // No per-trader equity curve API available.
  // The enrichment runner will use buildEquityCurveFromSnapshots as fallback.
  return []
}

/**
 * Compute ROI for a Bitfinex trader from rankings data.
 * Uses plu_diff (PnL USD) / plu (equity proxy), with plr (PnL ratio) as fallback.
 * Returns ROI as a percentage (e.g., 15.0 for 15%).
 */
export async function fetchBitfinexRoi(
  traderId: string,
  window: '7d' | '30d' = '30d'
): Promise<number | null> {
  try {
    const cache = await ensureRankingsCache()
    const id = traderId.toLowerCase()

    const pnlData = window === '7d' ? cache.pluDiff7d.get(id) : cache.pluDiff1m.get(id)
    const equity = cache.plu1m.get(id)

    // Primary: ROI = plu_diff / plu (PnL / equity proxy)
    if (pnlData && equity && Math.abs(equity.value) > 0.01 && pnlData.value !== 0) {
      return Math.max(-500, Math.min(50000, (pnlData.value / Math.abs(equity.value)) * 100))
    }

    // Fallback: plr value IS the profit/loss ratio (e.g., 0.15 = 15% return)
    const plrData = window === '7d' ? cache.plr7d.get(id) : cache.plr1m.get(id)
    if (plrData && plrData.value !== 0) {
      return Math.max(-500, Math.min(50000, plrData.value * 100))
    }

    return null
  } catch (err) {
    logger.warn(`[enrichment] Bitfinex ROI computation failed for ${traderId}: ${err}`)
    return null
  }
}

// ============================================
// Stats Detail
// ============================================

/**
 * Compute stats from Bitfinex rankings data.
 * We can derive:
 * - maxDrawdown: estimated from PnL changes across timeframes
 * - profitableTradesPct: not directly available but we can check if PnL > 0
 *
 * Since Bitfinex rankings only provide aggregate PnL data (not trade-level),
 * win_rate and MDD will primarily be populated by the derived metrics calculator
 * in enhanceStatsWithDerivedMetrics() from the equity curve built from daily snapshots.
 */
export async function fetchBitfinexStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const cache = await ensureRankingsCache()

    // Look up trader in all ranking keys
    const id = traderId.toLowerCase()
    const pnl1m = cache.pluDiff1m.get(id)
    const pnl7d = cache.pluDiff7d.get(id)
    const equity = cache.plu1m.get(id)

    if (!pnl1m && !pnl7d && !equity) {
      return null
    }

    // Estimate MDD from equity and PnL
    // If we have equity (inception profit) and period PnL, rough MDD estimate
    let maxDrawdown: number | null = null
    if (equity && pnl1m && equity.value > 0) {
      // If the trader lost money in a period relative to their equity
      // This is a rough lower-bound estimate
      const periodLoss = Math.min(0, pnl1m.value)
      if (periodLoss < 0) {
        maxDrawdown = Math.abs(periodLoss / equity.value) * 100
      }
    }

    return {
      totalTrades: null,
      profitableTradesPct: null, // Will be computed from equity curve by enhanceStatsWithDerivedMetrics
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: equity?.value != null ? Math.abs(equity.value) : null,
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] Bitfinex stats detail failed for ${traderId}: ${err}`)
    return null
  }
}
