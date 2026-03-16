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

  try {
    // Search leaderboard for this specific account
    const now = new Date()
    const queryDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const url = `${COPIN_BASE}/leaderboards/page?protocol=${copinProtocol}&statisticType=MONTH&queryDate=${queryDate}&limit=1000&offset=0&sort_by=ranking&sort_type=asc`

    const data = await fetchJson<CopinLeaderboardResponse>(url, { timeoutMs: 15000 })
    if (!data?.data) return null

    // Find our trader in the leaderboard
    const accountLower = account.toLowerCase()
    const found = data.data.find((t) => t.account.toLowerCase() === accountLower)
    return found || null
  } catch (err) {
    logger.warn(`[copin] Stats lookup failed for ${protocol}/${account}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
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
export async function fetchGainsStatsDetail(addr: string): Promise<StatsDetail | null> {
  return buildCopinStatsDetail('gains', addr)
}
export async function fetchGainsPositionHistory(_addr: string): Promise<PositionHistoryItem[]> {
  return []
}

// Aevo
export async function fetchAevoEquityCurve(_addr: string, _days: number): Promise<EquityCurvePoint[]> {
  // Aevo API only provides leaderboard with aggregate PnL/volume.
  return []
}
export async function fetchAevoStatsDetail(addr: string): Promise<StatsDetail | null> {
  return buildCopinStatsDetail('aevo', addr)
}
export async function fetchAevoPositionHistory(_addr: string): Promise<PositionHistoryItem[]> {
  return []
}
