/**
 * WOO X Enrichment
 *
 * WOO X provides public APIs for:
 * 1. Strategy metrics: GET /copy-trading-gateway/public/lead-strategy-profile/{id}/metrics?tradePeriod={period}
 *    - ROI, PnL, WinRate, Sharpe, MDD, trades count, copier assets
 * 2. Equity curve: Inline metricCharts (30-point daily ROI) from leaderboard-metrics
 * 3. Order history: GET /copy-trading-gateway/public/lead-strategy-profile/{id}/order-history
 * 4. Current positions: GET /copy-trading-gateway/public/lead-strategy-profile/{id}/portfolio-positions
 *
 * Notes:
 * - No auth required
 * - trader_key = strategyId
 * - ~12 curated lead traders
 */

import type { EquityCurvePoint, StatsDetail, PortfolioPosition, PositionHistoryItem } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const BASE = 'https://api.woox.io/copy-trading-gateway/public'

/**
 * Fetch equity curve from WOO X inline metricCharts.
 */
export async function fetchWooxEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    // Fetch leaderboard to get inline equity curve
    const raw = await fetchJson<{ data?: { metrics?: Array<Record<string, unknown>> } }>(
      `${BASE}/lead-trader-dashboard/leaderboard-metrics`,
      { timeoutMs: 10000 }
    )

    const metrics = raw?.data?.metrics
    if (!Array.isArray(metrics)) return []

    const trader = metrics.find(
      (m) => String(m.strategyId) === traderId || String(m.leadTraderId) === traderId
    )
    if (!trader?.metricCharts || !Array.isArray(trader.metricCharts)) return []

    const charts = trader.metricCharts as number[]
    // Take last N points based on requested days
    const sliced = days <= 7 ? charts.slice(-7) : days <= 30 ? charts : charts

    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000

    return sliced.map((roiDecimal: number, i: number) => {
      const date = new Date(now - (sliced.length - 1 - i) * dayMs)
      return {
        date: date.toISOString().split('T')[0],
        roi: roiDecimal * 100, // decimal → percentage
        pnl: null,
      }
    })
  } catch (err) {
    logger.warn(`[woox] Equity curve failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch detailed stats for a WOO X trader.
 */
export async function fetchWooxStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Fetch 90D metrics (most comprehensive)
    const raw = await fetchJson<{ success?: boolean; data?: Record<string, unknown> }>(
      `${BASE}/lead-strategy-profile/${traderId}/metrics?tradePeriod=NINETY_DAYS`,
      { timeoutMs: 10000 }
    )

    const data = raw?.data
    if (!data) return null

    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    const roi = num(data.roi)
    const winRate = num(data.winRate)
    const mdd = num(data.maxDrawdown)
    const trades = num(data.numberOfTrades)

    return {
      totalTrades: trades != null ? Math.round(trades) : null,
      profitableTradesPct: winRate != null ? winRate * 100 : null,
      avgHoldingTimeHours: num(data.avgHolding) != null ? num(data.avgHolding)! * 24 : null, // days → hours
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: num(data.sharpeRatio),
      maxDrawdown: mdd != null ? Math.abs(mdd * 100) : null,
      currentDrawdown: null,
      volatility: null,
      roi: roi != null ? roi * 100 : null,
      pnl: num(data.pnl),
      copiersCount: null, // Not in metrics endpoint
      copiersPnl: null,
      aum: num(data.copierAssets),
      winningPositions: null,
      totalPositions: trades != null ? Math.round(trades) : null,
    }
  } catch (err) {
    logger.warn(`[woox] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Fetch current positions for a WOO X trader.
 */
export async function fetchWooxCurrentPositions(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const raw = await fetchJson<{ data?: { positions?: Array<Record<string, unknown>> } }>(
      `${BASE}/lead-strategy-profile/${traderId}/portfolio-positions`,
      { timeoutMs: 10000 }
    )

    const positions = raw?.data?.positions
    if (!Array.isArray(positions) || positions.length === 0) return []

    return positions.map((pos) => ({
      symbol: String(pos.symbol || '').replace('PERP_', '').replace('_USDT', ''),
      direction: String(pos.side || '').toUpperCase() === 'SHORT' ? 'short' as const : 'long' as const,
      investedPct: null,
      entryPrice: pos.averageOpenPrice != null ? Number(pos.averageOpenPrice) : null,
      pnl: null,
    }))
  } catch (err) {
    logger.warn(`[woox] Positions failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch order history for a WOO X trader.
 */
export async function fetchWooxPositionHistory(
  traderId: string
): Promise<PositionHistoryItem[]> {
  try {
    const raw = await fetchJson<{ data?: { rows?: Array<Record<string, unknown>>; meta?: Record<string, unknown> } }>(
      `${BASE}/lead-strategy-profile/${traderId}/order-history?pageNumber=1&pageSize=100`,
      { timeoutMs: 10000 }
    )

    const rows = raw?.data?.rows
    if (!Array.isArray(rows) || rows.length === 0) return []

    return rows
      .filter((r) => r.action === 'FILLED')
      .map((r) => ({
        symbol: String(r.symbol || '').replace('PERP_', '').replace('_USDT', ''),
        direction: String(r.positionSide || '').toUpperCase() === 'SHORT' ? 'short' as const : 'long' as const,
        positionType: 'futures',
        marginMode: 'cross',
        openTime: r.modifiedTimestamp ? String(r.modifiedTimestamp) : null,
        closeTime: null,
        entryPrice: r.openPrice != null ? Number(r.openPrice) : null,
        exitPrice: r.price != null ? Number(r.price) : null,
        maxPositionSize: r.quantity != null ? Number(r.quantity) : null,
        closedSize: null,
        pnlUsd: r.pnl != null ? Number(r.pnl) : null,
        pnlPct: r.roi != null ? Number(r.roi) * 100 : null,
        status: 'closed',
      }))
  } catch (err) {
    logger.warn(`[woox] Position history failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
