/**
 * Bitunix Enrichment Module
 *
 * Uses the Bitunix copy-trading API for trader detail stats and position history.
 *
 * Endpoints:
 * - POST https://api.bitunix.com/copy/trading/v1/trader/detail  (trader stats)
 * - POST https://api.bitunix.com/copy/trading/v1/trader/positions (current positions, if showPosition=true)
 * - POST https://api.bitunix.com/copy/trading/v1/trader/history  (closed positions)
 */

import type { StatsDetail, PositionHistoryItem, PortfolioPosition } from './enrichment-types'
import { fetchWithProxyFallback } from './enrichment-types'
import { logger } from '@/lib/logger'

const API_BASE = 'https://api.bitunix.com/copy/trading/v1'

interface BitunixDetailResponse {
  code: number
  data?: {
    uid?: string | number
    nickname?: string
    header?: string | null
    roi?: string | number
    pl?: string | number
    winRate?: string | number
    mdd?: string | number
    currentFollow?: number
    aum?: string | number
    winCount?: number
    totalCount?: number
    avgHoldTime?: number // in seconds or hours
    avgProfit?: string | number
    avgLoss?: string | number
    largestWin?: string | number
    largestLoss?: string | number
    showPosition?: boolean
    totalPl?: string | number
    sharpeRatio?: string | number
  }
}

interface BitunixPositionEntry {
  symbol?: string
  side?: string | number // 1=long, 2=short or "BUY"/"SELL"
  openPrice?: string | number
  markPrice?: string | number
  size?: string | number
  leverage?: string | number
  unrealizedPl?: string | number
  margin?: string | number
  openTime?: string | number
  closeTime?: string | number
  closePrice?: string | number
  realizedPl?: string | number
  status?: string
}

interface BitunixPositionsResponse {
  code: number
  data?: {
    records?: BitunixPositionEntry[]
    list?: BitunixPositionEntry[]
  }
}

const toNum = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return isNaN(n) ? null : n
}

/**
 * Fetch stats detail from Bitunix trader detail API.
 */
export async function fetchBitunixStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchWithProxyFallback<BitunixDetailResponse>(
      `${API_BASE}/trader/detail`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { uid: traderId },
        timeoutMs: 10000,
      }
    )

    if (!data?.data || data.code !== 0) return null

    const d = data.data
    const totalTrades = toNum(d.totalCount)
    const winCount = toNum(d.winCount)
    const winRate = toNum(d.winRate)
    // winRate is in decimal format (0.65 = 65%)
    const profitableTradesPct = winRate != null ? winRate * 100 : null

    const mddRaw = toNum(d.mdd)
    const maxDrawdown = mddRaw != null ? Math.abs(mddRaw * 100) : null

    return {
      totalTrades,
      profitableTradesPct: profitableTradesPct != null ? Math.round(profitableTradesPct * 10) / 10 : null,
      avgHoldingTimeHours: toNum(d.avgHoldTime),
      avgProfit: toNum(d.avgProfit),
      avgLoss: toNum(d.avgLoss),
      largestWin: toNum(d.largestWin),
      largestLoss: toNum(d.largestLoss),
      sharpeRatio: toNum(d.sharpeRatio),
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: toNum(d.currentFollow),
      copiersPnl: null,
      aum: toNum(d.aum),
      winningPositions: winCount,
      totalPositions: totalTrades,
    }
  } catch (err) {
    logger.warn(`[bitunix] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Fetch current open positions from Bitunix.
 * Only works if the trader has showPosition=true in their detail.
 */
export async function fetchBitunixCurrentPositions(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const data = await fetchWithProxyFallback<BitunixPositionsResponse>(
      `${API_BASE}/trader/positions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { uid: traderId, pageNo: 1, pageSize: 50 },
        timeoutMs: 10000,
      }
    )

    if (!data?.data || data.code !== 0) return []

    const list = data.data.records || data.data.list || []
    if (list.length === 0) return []

    return list.map((pos) => {
      const side = typeof pos.side === 'string'
        ? (pos.side.toUpperCase() === 'BUY' || pos.side === '1' ? 'long' : 'short')
        : (pos.side === 1 ? 'long' : 'short')

      return {
        symbol: pos.symbol || 'UNKNOWN',
        direction: side as 'long' | 'short',
        investedPct: null,
        entryPrice: toNum(pos.openPrice),
        pnl: toNum(pos.unrealizedPl),
      }
    })
  } catch (err) {
    logger.warn(`[bitunix] Current positions failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch closed position history from Bitunix.
 */
export async function fetchBitunixPositionHistory(
  traderId: string
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchWithProxyFallback<BitunixPositionsResponse>(
      `${API_BASE}/trader/history`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { uid: traderId, pageNo: 1, pageSize: 100 },
        timeoutMs: 10000,
      }
    )

    if (!data?.data || data.code !== 0) return []

    const list = data.data.records || data.data.list || []
    if (list.length === 0) return []

    return list.map((pos) => {
      const side = typeof pos.side === 'string'
        ? (pos.side.toUpperCase() === 'BUY' || pos.side === '1' ? 'long' : 'short')
        : (pos.side === 1 ? 'long' : 'short')

      const openTime = pos.openTime
        ? (typeof pos.openTime === 'number' ? new Date(pos.openTime).toISOString() : String(pos.openTime))
        : null
      const closeTime = pos.closeTime
        ? (typeof pos.closeTime === 'number' ? new Date(pos.closeTime).toISOString() : String(pos.closeTime))
        : null

      return {
        symbol: pos.symbol || 'UNKNOWN',
        direction: side as 'long' | 'short',
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime,
        closeTime,
        entryPrice: toNum(pos.openPrice),
        exitPrice: toNum(pos.closePrice),
        maxPositionSize: toNum(pos.size),
        closedSize: toNum(pos.size),
        pnlUsd: toNum(pos.realizedPl),
        pnlPct: null,
        status: 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[bitunix] Position history failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Build equity curve from Bitunix (placeholder — no API for historical PnL).
 * Returns empty array; enrichment-runner will fall back to DB snapshots.
 */
export async function fetchBitunixEquityCurve(
  _traderId: string,
  _days: number
): Promise<Array<{ date: string; roi: number; pnl: number | null }>> {
  return []
}
