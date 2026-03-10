/**
 * Copin API Enrichment — shared module for DEX protocols
 *
 * Copin (api.copin.io) is a free DEX aggregator that supports:
 * - Position statistics: win/loss counts, trade counts, PnL, volume
 * - Position history: individual trades with timestamps, PnL, size
 * - Protocols: DYDX, KWENTA, GNS_V8, AEVO, SYNTHETIX_V3, etc.
 *
 * Used for platforms where native APIs don't expose trade-level data.
 */

import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'
import { buildEquityCurveFromPositions, computeStatsFromPositions } from './enrichment-dex'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const COPIN_BASE = 'https://api.copin.io'

// Protocol name mapping for Copin API
export const COPIN_PROTOCOLS: Record<string, string> = {
  kwenta: 'KWENTA',
  gains: 'GNS_V8',
  aevo: 'AEVO',
  dydx: 'DYDX',
  synthetix: 'SYNTHETIX_V3',
}

// ── Copin API types ──

interface CopinPosition {
  id?: string
  key?: string
  account: string
  smartAccount?: string
  indexToken?: string
  collateralToken?: string
  pair?: string
  size?: number
  collateral?: number
  averagePrice?: number
  closePrice?: number
  pnl?: number
  realisedPnl?: number
  roi?: number
  isLong?: boolean
  isWin?: boolean
  isLiquidate?: boolean
  openBlockTime?: string
  closeBlockTime?: string
  durationInSecond?: number
  leverage?: number
  orderCount?: number
  fee?: number
}

interface CopinPositionResponse {
  data: CopinPosition[]
  meta?: { total: number; totalPages: number; limit: number; offset: number }
}

interface CopinStatistic {
  totalTrade?: number
  totalWin?: number
  totalLose?: number
  totalVolume?: number
  totalPnl?: number
  totalRealisedPnl?: number
  totalFee?: number
  maxDrawdown?: number
  maxDrawdownPnl?: number
  avgRoi?: number
  avgLeverage?: number
  avgDuration?: number
}

interface CopinStatisticResponse {
  data: CopinStatistic[]
}

// ── Fetch functions ──

/**
 * Fetch position history from Copin API.
 * Returns individual closed trades with PnL, size, direction, timestamps.
 */
export async function fetchCopinPositionHistory(
  protocol: string,
  account: string,
  limit = 100
): Promise<PositionHistoryItem[]> {
  const copinProtocol = COPIN_PROTOCOLS[protocol] || protocol.toUpperCase()

  try {
    const url = `${COPIN_BASE}/${copinProtocol}/position/filter?accounts=${account}&status=CLOSE&limit=${limit}&offset=0&sortBy=closeBlockTime&sortType=desc`
    const data = await fetchJson<CopinPositionResponse>(url, { timeoutMs: 15000 })

    if (!data?.data || data.data.length === 0) return []

    return data.data
      .filter((p) => p.closeBlockTime)
      .map((p) => ({
        symbol: p.pair || p.indexToken || 'UNKNOWN',
        direction: p.isLong ? 'long' as const : 'short' as const,
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: p.openBlockTime || null,
        closeTime: p.closeBlockTime || null,
        entryPrice: p.averagePrice || null,
        exitPrice: p.closePrice || null,
        maxPositionSize: p.size || null,
        closedSize: p.size || null,
        pnlUsd: p.realisedPnl ?? p.pnl ?? null,
        pnlPct: p.roi != null ? p.roi * 100 : null,
        status: p.isLiquidate ? 'liquidated' : 'closed',
      }))
  } catch (err) {
    logger.warn(`[copin] Position history failed for ${protocol}/${account}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch trader statistics from Copin API.
 */
export async function fetchCopinStatistics(
  protocol: string,
  account: string
): Promise<CopinStatistic | null> {
  const copinProtocol = COPIN_PROTOCOLS[protocol] || protocol.toUpperCase()

  try {
    const url = `${COPIN_BASE}/${copinProtocol}/position/statistic/filter?accounts=${account}&statisticType=MONTH`
    const data = await fetchJson<CopinStatisticResponse>(url, { timeoutMs: 10000 })
    if (data?.data && data.data.length > 0) {
      return data.data[0]
    }
  } catch {
    // Not critical
  }
  return null
}

/**
 * Build equity curve from Copin position history.
 */
export async function fetchCopinEquityCurve(
  protocol: string,
  account: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const positions = await fetchCopinPositionHistory(protocol, account, 200)
    if (positions.length === 0) return []
    return buildEquityCurveFromPositions(positions, days)
  } catch (err) {
    logger.warn(`[copin] Equity curve failed for ${protocol}/${account}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Build stats detail from Copin data.
 * Combines position statistics + computed stats from position history.
 */
export async function fetchCopinStatsDetail(
  protocol: string,
  account: string
): Promise<StatsDetail | null> {
  try {
    // Fetch statistics and position history in parallel
    const [copinStats, positions] = await Promise.all([
      fetchCopinStatistics(protocol, account),
      fetchCopinPositionHistory(protocol, account, 200),
    ])

    // Compute trade stats from position history
    const derivedStats = positions.length > 0 ? computeStatsFromPositions(positions) : {}

    const totalTrades = copinStats?.totalTrade ?? derivedStats.totalTrades ?? null
    const totalWin = copinStats?.totalWin ?? derivedStats.winningPositions ?? null
    const profitableTradesPct = totalTrades && totalTrades > 0 && totalWin != null
      ? Math.round((totalWin / totalTrades) * 1000) / 10
      : (derivedStats.profitableTradesPct ?? null)

    return {
      totalTrades,
      profitableTradesPct,
      avgHoldingTimeHours: copinStats?.avgDuration != null
        ? Math.round((copinStats.avgDuration / 3600) * 10) / 10
        : null,
      avgProfit: derivedStats.avgProfit ?? null,
      avgLoss: derivedStats.avgLoss ?? null,
      largestWin: derivedStats.largestWin ?? null,
      largestLoss: derivedStats.largestLoss ?? null,
      sharpeRatio: null, // Computed from equity curve
      maxDrawdown: copinStats?.maxDrawdown != null
        ? Math.abs(copinStats.maxDrawdown * 100) // Copin returns as ratio
        : (derivedStats.maxDrawdown ?? null),
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: null,
      winningPositions: totalWin,
      totalPositions: totalTrades,
    }
  } catch (err) {
    logger.warn(`[copin] Stats detail failed for ${protocol}/${account}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ── Platform-specific wrappers ──

// Kwenta
export const fetchKwentaEquityCurve = (addr: string, days: number) => fetchCopinEquityCurve('kwenta', addr, days)
export const fetchKwentaStatsDetail = (addr: string) => fetchCopinStatsDetail('kwenta', addr)
export const fetchKwentaPositionHistory = (addr: string) => fetchCopinPositionHistory('kwenta', addr, 100)

// Gains Network
export const fetchGainsEquityCurve = (addr: string, days: number) => fetchCopinEquityCurve('gains', addr, days)
export const fetchGainsStatsDetail = (addr: string) => fetchCopinStatsDetail('gains', addr)
export const fetchGainsPositionHistory = (addr: string) => fetchCopinPositionHistory('gains', addr, 100)

// Aevo
export const fetchAevoEquityCurve = (addr: string, days: number) => fetchCopinEquityCurve('aevo', addr, days)
export const fetchAevoStatsDetail = (addr: string) => fetchCopinStatsDetail('aevo', addr)
export const fetchAevoPositionHistory = (addr: string) => fetchCopinPositionHistory('aevo', addr, 100)
