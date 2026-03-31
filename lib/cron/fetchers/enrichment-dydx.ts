/**
 * dYdX v4 Enrichment Module
 *
 * 2026-03-31: Rewrote to use Copin API as sole data source.
 * The dYdX indexer (indexer.dydx.trade) has been dead/TCP-hanging since ~2026-03,
 * causing 30+ minute hangs that bypass fetch timeouts at the TCP level.
 * All indexer calls removed. Copin provides stats, equity curve, and position data.
 *
 * Hard 8s AbortSignal.timeout() on every fetch to guarantee fail-fast.
 */

import type { EquityCurvePoint, StatsDetail, PositionHistoryItem } from './enrichment-types'
import { logger } from '@/lib/logger'

// Hard timeout for ALL fetch calls — uses AbortSignal.timeout() which works at runtime level
// even when TCP hangs (unlike setTimeout + AbortController which can fail on TCP stalls)
const FETCH_TIMEOUT_MS = 8_000

// Copin API — reliable, fast, covers dYdX traders
const COPIN_BASE = 'https://api.copin.io'

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
}

/**
 * Hard-timeout fetch wrapper using AbortSignal.timeout().
 * This is more reliable than setTimeout + AbortController for TCP-level hangs.
 */
async function hardFetch<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const res = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url.slice(0, 100)}`)
  }
  return (await res.json()) as T
}

// Copin trader detail API for win/loss stats
interface CopinTraderDetail {
  totalTrade?: number
  totalWin?: number
  totalLose?: number
  totalVolume?: number
  totalPnl?: number
  totalRealisedPnl?: number
  maxDrawdown?: number
  account?: string
}

interface CopinPositionDetail {
  account?: string
  openBlockTime?: string
  closeBlockTime?: string
  pair?: string
  isLong?: boolean
  size?: number
  collateral?: number
  leverage?: number
  pnl?: number
  roi?: number
  fee?: number
  status?: string
  averagePrice?: number
  entryPrice?: number
  closePrice?: number
}

/**
 * Fetch equity curve from Copin position history.
 * Builds daily PnL curve from closed positions.
 */
export async function fetchDydxEquityCurve(
  address: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    // Copin position list — get closed positions for this trader
    const url = `${COPIN_BASE}/DYDX/position/filter?accounts=${address}&status=CLOSE&limit=500&sort_by=closeBlockTime&sort_type=desc`
    const data = await hardFetch<{ data?: CopinPositionDetail[] }>(url)

    if (!data?.data || data.data.length === 0) {
      // Fallback: try stats endpoint for at least a 2-point curve
      return await fetchEquityCurveFromStats(address, days)
    }

    const positions = data.data

    // Build daily cumulative PnL from closed positions
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)
    const cutoff = cutoffDate.toISOString()

    const dailyPnl = new Map<string, number>()
    for (const pos of positions) {
      const closeTime = pos.closeBlockTime
      if (!closeTime || closeTime < cutoff) continue
      const date = closeTime.split('T')[0]
      const pnl = pos.pnl ?? 0
      dailyPnl.set(date, (dailyPnl.get(date) ?? 0) + pnl)
    }

    if (dailyPnl.size === 0) {
      return await fetchEquityCurveFromStats(address, days)
    }

    // Sort by date and compute cumulative
    const sortedDates = [...dailyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let cumPnl = 0
    const points: EquityCurvePoint[] = sortedDates.map(([date, pnl]) => {
      cumPnl += pnl
      return { date, roi: 0, pnl: cumPnl }
    })

    // Compute ROI relative to first point
    if (points.length >= 2) {
      const initialPnl = points[0].pnl ?? 0
      for (const point of points) {
        const pnlDiff = (point.pnl ?? 0) - initialPnl
        point.roi = initialPnl !== 0 ? (pnlDiff / Math.abs(initialPnl)) * 100 : 0
      }
    }

    return points
  } catch (err) {
    logger.warn(`[dydx] Equity curve failed for ${address}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fallback: build a minimal equity curve from Copin stats (2-point: start and current).
 */
async function fetchEquityCurveFromStats(address: string, days: number): Promise<EquityCurvePoint[]> {
  try {
    const statisticType = days <= 7 ? 'WEEK' : 'MONTH'
    const url = `${COPIN_BASE}/DYDX/position/statistic/filter?accounts=${address}&statisticType=${statisticType}`
    const data = await hardFetch<{ data?: CopinTraderDetail[] }>(url)

    if (!data?.data || data.data.length === 0) return []

    const stats = data.data[0]
    const totalPnl = stats.totalPnl ?? stats.totalRealisedPnl ?? 0
    if (totalPnl === 0) return []

    const today = new Date().toISOString().split('T')[0]
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)
    const start = startDate.toISOString().split('T')[0]

    return [
      { date: start, roi: 0, pnl: 0 },
      { date: today, roi: 0, pnl: totalPnl },
    ]
  } catch {
    return []
  }
}

/**
 * Fetch stats for a dYdX trader from Copin API.
 * No indexer calls — Copin provides all needed stats.
 */
export async function fetchDydxStatsDetail(
  address: string
): Promise<StatsDetail | null> {
  try {
    const copinStats = await fetchCopinTraderStats(address)
    if (!copinStats) return null

    const totalTrades = copinStats.totalTrade ?? null
    const totalWin = copinStats.totalWin ?? null
    const profitableTradesPct = totalTrades && totalTrades > 0 && totalWin != null
      ? (totalWin / totalTrades) * 100
      : null

    // Estimate AUM from totalVolume / assumed leverage
    const aum = copinStats.totalVolume && copinStats.totalVolume > 0
      ? Math.round(copinStats.totalVolume / 5) // ~5x avg leverage estimate
      : null

    return {
      totalTrades,
      profitableTradesPct: profitableTradesPct != null ? Math.round(profitableTradesPct * 10) / 10 : null,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null, // Computed from equity curve
      maxDrawdown: copinStats.maxDrawdown != null ? Math.abs(copinStats.maxDrawdown) : null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum,
      winningPositions: totalWin,
      totalPositions: totalTrades,
    }
  } catch (err) {
    logger.warn(`[dydx] Stats detail failed for ${address}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchCopinTraderStats(address: string): Promise<CopinTraderDetail | null> {
  try {
    const url = `${COPIN_BASE}/DYDX/position/statistic/filter?accounts=${address}&statisticType=MONTH`
    const data = await hardFetch<{ data?: CopinTraderDetail[] }>(url)
    if (data?.data && data.data.length > 0) {
      return data.data[0]
    }
  } catch {
    // Copin API not available — not critical
  }
  return null
}

// ============================================
// dYdX Position History via Copin
// ============================================

/**
 * Fetch position history from Copin API.
 * Replaces dYdX indexer fills API which TCP-hangs.
 */
export async function fetchDydxV4PositionHistory(
  address: string
): Promise<PositionHistoryItem[]> {
  try {
    const url = `${COPIN_BASE}/DYDX/position/filter?accounts=${address}&limit=100&sort_by=closeBlockTime&sort_type=desc`
    const data = await hardFetch<{ data?: CopinPositionDetail[] }>(url)

    if (!data?.data || data.data.length === 0) return []

    return data.data.map((pos) => ({
      symbol: pos.pair || 'UNKNOWN',
      direction: pos.isLong ? 'long' as const : 'short' as const,
      positionType: 'perpetual',
      marginMode: 'cross',
      openTime: pos.openBlockTime || null,
      closeTime: pos.closeBlockTime || null,
      entryPrice: pos.entryPrice ?? pos.averagePrice ?? null,
      exitPrice: pos.closePrice ?? null,
      maxPositionSize: pos.size ?? null,
      closedSize: pos.size ?? null,
      pnlUsd: pos.pnl ?? null,
      pnlPct: pos.roi != null ? pos.roi * 100 : null,
      status: pos.status === 'CLOSE' ? 'closed' : (pos.status?.toLowerCase() || 'filled'),
    }))
  } catch (err) {
    logger.warn(`[dydx] Position history failed for ${address}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
