/**
 * Copin API Enrichment — shared module for DEX protocols
 *
 * Copin (api.copin.io) supports leaderboard data for:
 * DYDX, KWENTA, SYNTHETIX, SYNTHETIX_V3, GNS, etc.
 *
 * Note: Copin position filter API now requires txHash — bulk position queries
 * no longer work. We use the leaderboard data for stats and compute equity
 * curves from our own snapshot data when native APIs aren't available.
 *
 * For platforms without native trade history APIs (Aevo, Kwenta, Gains),
 * we compute equity curves from daily PnL diffs in trader_snapshots.
 */

import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const COPIN_BASE = 'https://api.copin.io'

// Protocol name mapping for Copin API
export const COPIN_PROTOCOLS: Record<string, string> = {
  kwenta: 'KWENTA',
  gains: 'GNS',
  aevo: 'AEVO',
  dydx: 'DYDX',
  synthetix: 'SYNTHETIX_V3',
}

// ── Copin API types ──

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

interface CopinTraderStats {
  account: string
  totalPnl: number
  totalVolume: number
  totalTrade: number
  totalWin: number
  totalLose: number
  totalLiquidation?: number
  totalFee?: number
  maxDrawdown?: number
  maxDrawdownPnl?: number
}

interface CopinLeaderboardResponse {
  data: CopinTraderStats[]
  meta?: { total: number; totalPages: number; limit: number; offset: number }
}

// ── Fetch functions ──

/**
 * Fetch trader stats from Copin leaderboard API.
 * Returns win/loss/trade counts for a specific trader.
 */
async function fetchCopinTraderStats(
  protocol: string,
  account: string
): Promise<CopinTraderStats | null> {
  const copinProtocol = COPIN_PROTOCOLS[protocol] || protocol.toUpperCase()
  const accountLower = account.toLowerCase()

  // Try multiple statistic types — MONTH first (most common), then WEEK, then D60
  // Different traders may only appear in certain time ranges
  const now = new Date()
  const queryDates: Array<{ type: string; date: number }> = [
    { type: 'MONTH', date: new Date(now.getFullYear(), now.getMonth(), 1).getTime() },
    { type: 'WEEK', date: now.getTime() },
    { type: 'D60', date: now.getTime() },
  ]

  for (const { type, date } of queryDates) {
    try {
      const url = `${COPIN_BASE}/leaderboards/page?protocol=${copinProtocol}&statisticType=${type}&queryDate=${date}&limit=1000&offset=0&sort_by=ranking&sort_type=asc`

      const data = await fetchJson<CopinLeaderboardResponse>(url, { timeoutMs: 15000 })
      if (!data?.data) continue

      const found = data.data.find((t) => t.account.toLowerCase() === accountLower)
      if (found) return found
    } catch (err) {
      logger.warn(`[copin] Stats lookup failed for ${protocol}/${account} (${type}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return null
}

/**
 * Build stats detail from Copin leaderboard data.
 */
async function buildCopinStatsDetail(
  protocol: string,
  account: string
): Promise<StatsDetail | null> {
  const copinStats = await fetchCopinTraderStats(protocol, account)
  if (!copinStats) return null

  const totalTrades = copinStats.totalTrade || 0
  const totalWin = copinStats.totalWin || 0
  const profitableTradesPct = totalTrades > 0
    ? Math.round((totalWin / totalTrades) * 1000) / 10
    : null

  // Copin may provide maxDrawdown (as negative percentage or absolute value)
  let maxDrawdown: number | null = null
  if (copinStats.maxDrawdown != null && copinStats.maxDrawdown !== 0) {
    maxDrawdown = Math.min(Math.abs(copinStats.maxDrawdown), 100)
    maxDrawdown = Math.round(maxDrawdown * 100) / 100
  }

  // Compute ROI from totalPnl / totalVolume (Copin provides both)
  let roi: number | null = null
  const totalPnl = copinStats.totalPnl
  const totalVolume = copinStats.totalVolume
  if (totalPnl != null && totalVolume != null && totalVolume > 0) {
    roi = Math.round((totalPnl / totalVolume) * 100 * 100) / 100 // percentage, 2 decimals
    // Sanity bounds: -500% to 10000%
    roi = Math.max(-500, Math.min(10000, roi))
  }

  return {
    totalTrades: totalTrades > 0 ? totalTrades : null,
    profitableTradesPct,
    avgHoldingTimeHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    sharpeRatio: null,
    maxDrawdown,
    currentDrawdown: null,
    volatility: null,
    roi,
    pnl: totalPnl != null ? totalPnl : null,
    copiersCount: null,
    copiersPnl: null,
    aum: null,
    winningPositions: totalWin > 0 ? totalWin : null,
    totalPositions: totalTrades > 0 ? totalTrades : null,
  }
}

// ── Platform-specific wrappers ──
// These return null/empty when Copin doesn't have data for the protocol.
// The enrichment runner handles this gracefully.

// Kwenta
export async function fetchKwentaEquityCurve(_addr: string, _days: number): Promise<EquityCurvePoint[]> {
  // Kwenta doesn't have a public trade history API.
  // Equity curves come from our own daily snapshot diffs (aggregate-daily-snapshots cron).
  return []
}
export async function fetchKwentaStatsDetail(addr: string): Promise<StatsDetail | null> {
  return buildCopinStatsDetail('kwenta', addr)
}
export async function fetchKwentaPositionHistory(_addr: string): Promise<PositionHistoryItem[]> {
  return []
}

// Gains Network
export async function fetchGainsEquityCurve(_addr: string, _days: number): Promise<EquityCurvePoint[]> {
  // Gains leaderboard API only returns aggregate stats, no trade-level history.
  return []
}

/**
 * Fetch Gains stats — primary: native Gains stats API, fallback: Copin.
 * The native API (backend-global.gains.trade) returns per-trader stats
 * including totalPnl, totalVolume, trades, wins — enabling ROI computation.
 */
export async function fetchGainsStatsDetail(addr: string): Promise<StatsDetail | null> {
  // Primary: Gains native per-trader stats API
  try {
    const nativeStats = await fetchGainsNativeStats(addr)
    if (nativeStats) return nativeStats
  } catch (err) {
    logger.warn(`[gains] Native stats failed for ${addr}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Fallback: Copin leaderboard stats (also computes ROI from totalPnl/totalVolume)
  return buildCopinStatsDetail('gains', addr)
}

/**
 * Fetch per-trader stats from Gains Network native API.
 * Endpoint: https://backend-global.gains.trade/api/personal-trading-history/{address}/stats?chainId=42161
 *
 * Returns aggregate stats including totalPnl, totalVolume, win/loss counts.
 * ROI is computed as (totalPnl / totalVolume) * 100.
 */
async function fetchGainsNativeStats(addr: string): Promise<StatsDetail | null> {
  // Try all chains (Arbitrum first as most active)
  const chains = [
    { chainId: '42161', name: 'arbitrum' },
    { chainId: '137', name: 'polygon' },
    { chainId: '8453', name: 'base' },
  ]

  for (const chain of chains) {
    try {
      const url = `https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${chain.chainId}`
      const data = await fetchJson<GainsNativeStatsResponse>(url, { timeoutMs: 10000 })
      if (!data) continue

      // The API may return an object with stats fields or nested data
      const totalTrades = data.totalTrades ?? data.total_trades ?? data.nbTrades ?? 0
      const totalWin = data.totalWin ?? data.wins ?? data.nbWins ?? 0
      const totalPnl = data.totalPnl ?? data.pnl ?? data.totalPnlCollateral ?? null
      const totalVolume = data.totalVolume ?? data.volume ?? data.totalCollateral ?? null

      // Skip empty responses
      if (totalTrades === 0 && totalPnl == null) continue

      const profitableTradesPct = totalTrades > 0
        ? Math.round((totalWin / totalTrades) * 1000) / 10
        : null

      // Compute ROI from totalPnl / totalVolume
      let roi: number | null = null
      if (totalPnl != null && totalVolume != null && totalVolume > 0) {
        roi = Math.round((totalPnl / totalVolume) * 100 * 100) / 100
        roi = Math.max(-500, Math.min(10000, roi))
      }

      // Max drawdown from API if available
      let maxDrawdown: number | null = null
      const rawMdd = data.maxDrawdown ?? data.max_drawdown ?? null
      if (rawMdd != null && rawMdd !== 0) {
        maxDrawdown = Math.min(Math.abs(rawMdd), 100)
        maxDrawdown = Math.round(maxDrawdown * 100) / 100
      }

      return {
        totalTrades: totalTrades > 0 ? totalTrades : null,
        profitableTradesPct,
        avgHoldingTimeHours: null,
        avgProfit: data.avgWin ?? data.avg_win ?? null,
        avgLoss: data.avgLoss ?? data.avg_loss ?? null,
        largestWin: data.largestWin ?? data.bestPnl ?? null,
        largestLoss: data.largestLoss ?? data.worstPnl ?? null,
        sharpeRatio: null,
        maxDrawdown,
        currentDrawdown: null,
        volatility: null,
        roi,
        pnl: totalPnl,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: totalWin > 0 ? totalWin : null,
        totalPositions: totalTrades > 0 ? totalTrades : null,
      }
    } catch {
      // Try next chain
      continue
    }
  }

  return null
}

// Gains native stats API response shape (flexible — fields vary by version)
interface GainsNativeStatsResponse {
  totalTrades?: number
  total_trades?: number
  nbTrades?: number
  totalWin?: number
  wins?: number
  nbWins?: number
  totalPnl?: number
  pnl?: number
  totalPnlCollateral?: number
  totalVolume?: number
  volume?: number
  totalCollateral?: number
  maxDrawdown?: number
  max_drawdown?: number
  avgWin?: number
  avg_win?: number
  avgLoss?: number
  avg_loss?: number
  largestWin?: number
  bestPnl?: number
  largestLoss?: number
  worstPnl?: number
}

export async function fetchGainsPositionHistory(_addr: string): Promise<PositionHistoryItem[]> {
  return []
}

// Aevo — native API provides stats, Copin provides position data for equity curves
export async function fetchAevoEquityCurve(addr: string, days: number): Promise<EquityCurvePoint[]> {
  // Try Copin position data to build equity curve (same approach as dYdX)
  try {
    const url = `${COPIN_BASE}/AEVO/position/filter?accounts=${addr}&status=CLOSE&limit=500&sort_by=closeBlockTime&sort_type=desc`
    const data = await fetchJson<{ data?: CopinPositionDetail[] }>(url, { timeoutMs: 10000 })

    if (!data?.data || data.data.length === 0) return []

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)
    const cutoff = cutoffDate.toISOString()

    // Build daily cumulative PnL
    const dailyPnl = new Map<string, number>()
    for (const pos of data.data) {
      const closeTime = pos.closeBlockTime
      if (!closeTime || closeTime < cutoff) continue
      const date = closeTime.split('T')[0]
      const pnl = pos.pnl ?? 0
      dailyPnl.set(date, (dailyPnl.get(date) ?? 0) + pnl)
    }

    if (dailyPnl.size === 0) return []

    // Sort by date, gap-fill, and compute cumulative
    const sortedDates = [...dailyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let cumPnl = 0
    const sparseCum = new Map<string, number>()
    for (const [date, pnl] of sortedDates) {
      cumPnl += pnl
      sparseCum.set(date, cumPnl)
    }

    // Gap-fill missing days
    const firstDate = new Date(sortedDates[0][0])
    const lastDate = new Date(sortedDates[sortedDates.length - 1][0])
    const points: EquityCurvePoint[] = []
    let prevCumPnl = 0
    for (let d = new Date(firstDate); d <= lastDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0]
      const val = sparseCum.get(dateStr)
      if (val !== undefined) prevCumPnl = val
      points.push({ date: dateStr, roi: 0, pnl: prevCumPnl })
    }

    // Estimate ROI from total volume
    const totalVolume = data.data.reduce((sum, pos) => sum + Math.abs(pos.size ?? pos.collateral ?? 0), 0)
    const estimatedCapital = totalVolume > 0 ? totalVolume / 5 : Math.abs(cumPnl) * 5
    if (estimatedCapital > 0) {
      for (const p of points) {
        p.roi = ((p.pnl ?? 0) / estimatedCapital) * 100
      }
    }

    return points
  } catch (err) {
    logger.warn(`[aevo] Copin equity curve failed for ${addr}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export async function fetchAevoStatsDetail(addr: string): Promise<StatsDetail | null> {
  // Primary: Aevo native /account/{address}/statistics API (richer data)
  try {
    const nativeStats = await fetchJson<{
      win_rate?: number
      max_drawdown?: number
      sharpe_ratio?: number
      total_trades?: number
      total_volume?: number
      pnl?: number
    }>(`https://api.aevo.xyz/account/${addr}/statistics`, { timeoutMs: 10000 })

    if (nativeStats && (nativeStats.win_rate != null || nativeStats.max_drawdown != null)) {
      return {
        totalTrades: nativeStats.total_trades ?? null,
        profitableTradesPct: nativeStats.win_rate != null ? nativeStats.win_rate * 100 : null,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: nativeStats.sharpe_ratio ?? null,
        maxDrawdown: nativeStats.max_drawdown != null ? Math.abs(nativeStats.max_drawdown) * 100 : null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: nativeStats.total_trades ?? null,
      }
    }
  } catch (err) {
    logger.warn(`[aevo] Native stats failed for ${addr}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Fallback: Copin leaderboard stats
  return buildCopinStatsDetail('aevo', addr)
}

export async function fetchAevoPositionHistory(addr: string): Promise<PositionHistoryItem[]> {
  try {
    const url = `${COPIN_BASE}/AEVO/position/filter?accounts=${addr}&limit=100&sort_by=closeBlockTime&sort_type=desc`
    const data = await fetchJson<{ data?: CopinPositionDetail[] }>(url, { timeoutMs: 10000 })

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
    logger.warn(`[aevo] Copin position history failed for ${addr}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
