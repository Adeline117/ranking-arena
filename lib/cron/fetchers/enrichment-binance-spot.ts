/**
 * Binance Spot enrichment: stats detail + equity curve
 *
 * Uses the same /friendly/ spot-copy-trade API as the connector.
 * API endpoints:
 * - Performance: GET /v1/public/future/spot-copy-trade/lead-portfolio/performance?portfolioId=...&timeRange=90D
 * - Chart data: GET /v1/public/future/spot-copy-trade/lead-portfolio/chart-data?dataType=ROI&portfolioId=...&timeRange=90D
 * - Detail: GET /v1/friendly/future/spot-copy-trade/lead-portfolio/detail?portfolioId=...
 *
 * Note: These are the same pattern as binance_futures but with "spot-copy-trade" in the path.
 * All are geo-blocked — uses VPS proxy fallback.
 */

import { logger } from '@/lib/logger'
import { fetchWithProxyFallback } from './enrichment-types'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

const BINANCE_PUBLIC = 'https://www.binance.com/bapi/futures/v1/public/future/spot-copy-trade'
const BINANCE_FRIENDLY = 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade'

// ============================================
// Equity Curve
// ============================================

export async function fetchBinanceSpotEquityCurve(
  traderId: string,
  timeRange: string = '90D'
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchWithProxyFallback<Record<string, unknown>>(
      `${BINANCE_PUBLIC}/lead-portfolio/chart-data?dataType=ROI&portfolioId=${traderId}&timeRange=${timeRange}`,
      { method: 'GET', timeoutMs: 10000 }
    )

    const points = Array.isArray(data?.data) ? data.data as Array<{ value: number; dateTime: number }> : []
    if (points.length === 0) return []

    return points.map(p => ({
      date: new Date(p.dateTime).toISOString().slice(0, 10),
      roi: p.value,
      pnl: null,
    }))
  } catch (err) {
    logger.warn(`[enrichment] Binance Spot equity curve failed for ${traderId}: ${err}`)
    return []
  }
}

// ============================================
// Stats Detail
// ============================================

interface BinanceSpotPerformanceResponse {
  code?: string
  data?: {
    timeRange?: string
    roi?: number
    pnl?: number
    mdd?: number
    winRate?: number
    winOrders?: number
    totalOrder?: number
    sharpRatio?: number | null
    copierPnl?: number
  }
}

export async function fetchBinanceSpotStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const perfData = await fetchWithProxyFallback<BinanceSpotPerformanceResponse>(
      `${BINANCE_PUBLIC}/lead-portfolio/performance?portfolioId=${traderId}&timeRange=90D`,
      { method: 'GET', timeoutMs: 10000 }
    )

    if (!perfData?.data) return null
    const d = perfData.data

    // Also fetch detail for AUM and follower count
    let aum: number | null = null
    let copiersCount: number | null = null
    try {
      const detailData = await fetchWithProxyFallback<Record<string, unknown>>(
        `${BINANCE_FRIENDLY}/lead-portfolio/detail?portfolioId=${traderId}`,
        { method: 'GET', timeoutMs: 8000 }
      )
      const dd = detailData?.data as Record<string, unknown> | null
      if (dd) {
        aum = dd.aum != null ? Number(dd.aum) : null
        copiersCount = dd.currentCopyCount != null ? Number(dd.currentCopyCount) : null
      }
    } catch (err) {
      logger.warn(`[enrichment-binance-spot] Detail fetch failed for trader ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const totalTrades = d.totalOrder ?? 0
    const winOrders = d.winOrders ?? 0

    return {
      totalTrades,
      profitableTradesPct: d.winRate != null ? d.winRate : (totalTrades > 0 ? (winOrders / totalTrades) * 100 : null),
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: d.sharpRatio ?? null,
      maxDrawdown: d.mdd ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount,
      copiersPnl: d.copierPnl ?? null,
      aum,
      winningPositions: winOrders,
      totalPositions: totalTrades,
    }
  } catch (err) {
    logger.warn(`[enrichment] Binance Spot stats detail failed for ${traderId}: ${err}`)
    return null
  }
}
