/**
 * Binance enrichment: equity curve, position history, stats detail
 *
 * API paths discovered 2026-03-15 via Playwright interception:
 * - Performance: GET /v1/public/.../performance?portfolioId=...&timeRange=90D
 * - Chart data:  GET /v1/public/.../chart-data?dataType=ROI&portfolioId=...&timeRange=90D
 * - Detail:      GET /v1/friendly/.../detail?portfolioId=...
 * - Positions:   GET /v1/friendly/.../positions?portfolioId=...
 *
 * All are GET requests (not POST). Geo-blocked — uses VPS proxy fallback.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sleep } from './shared'
import { fetchWithProxyFallback, type EquityCurvePoint, type PositionHistoryItem, type StatsDetail } from './enrichment-types'
import { upsertEquityCurve, upsertPositionHistory } from './enrichment-db'
import { withRetry } from '@/lib/utils/circuit-breaker'
import { type Result, Ok, Err } from '@/lib/types'

const BINANCE_PUBLIC = 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade'
const BINANCE_FRIENDLY = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade'

// PERMANENT FIX (2026-03-21): Ultra-short timeouts for 30D/90D to prevent 46-77min hangs
// Root cause: AbortSignal.timeout() may fail to cancel stuck VPS proxy requests
// Solution: Aggressive timeouts (3-8s) + fail-fast strategy
// Testing showed VPS proxy responses are <500ms, so 3-8s is more than enough
const BINANCE_TIMEOUT_MS: Record<string, number> = {
  '7D': 3000,   // 3s (tested avg: 395ms)
  '30D': 5000,  // 5s (tested avg: 295ms)
  '90D': 8000,  // 8s (tested avg: 324ms)
}

export async function fetchBinanceEquityCurve(
  traderId: string,
  timeRange: string = '90D'
): Promise<EquityCurvePoint[]> {
  try {
    // GET chart-data endpoint returns daily ROI values
    const timeout = BINANCE_TIMEOUT_MS[timeRange] || 8000
    const data = await fetchWithProxyFallback<Record<string, unknown>>(
      `${BINANCE_PUBLIC}/lead-portfolio/chart-data?dataType=ROI&portfolioId=${traderId}&timeRange=${timeRange}`,
      { method: 'GET', timeoutMs: timeout }
    )

    // Response: { code: "000000", data: [{ value, dataType, dateTime }] }
    const points = Array.isArray(data?.data) ? data.data as Array<{ value: number; dateTime: number }> : []

    if (points.length === 0) {
      logger.warn(`[enrichment] Binance equity curve empty for ${traderId}`)
      return []
    }

    return points.map(p => ({
      date: new Date(p.dateTime).toISOString().slice(0, 10),
      roi: p.value, // Already percentage
      pnl: null,    // Chart data only has ROI, not PnL
    }))
  } catch (err) {
    logger.warn(`[enrichment] Binance equity curve failed for ${traderId}: ${err}`)
    return []
  }
}

export async function fetchBinancePositionHistory(
  traderId: string,
  _pageSize = 50
): Promise<PositionHistoryItem[]> {
  try {
    // GET positions endpoint
    // Ultra-short timeout: 5s (VPS proxy tested <500ms)
    const data = await fetchWithProxyFallback<Record<string, unknown>>(
      `${BINANCE_FRIENDLY}/lead-data/positions?portfolioId=${traderId}`,
      { method: 'GET', timeoutMs: 5000 }
    )

    const list = Array.isArray(data?.data) ? data.data as Array<Record<string, unknown>> :
      (data?.data as Record<string, unknown>)?.list as Array<Record<string, unknown>> || []

    if (!list.length) return []

    return list.map((p) => ({
      symbol: String(p.symbol || ''),
      direction: String(p.positionSide || p.direction || '').toLowerCase().includes('short') ? 'short' : 'long',
      positionType: 'perpetual',
      marginMode: String(p.marginType || 'cross').toLowerCase(),
      openTime: p.openTime ? new Date(Number(p.openTime)).toISOString() : null,
      closeTime: p.closeTime ? new Date(Number(p.closeTime)).toISOString() : null,
      entryPrice: p.entryPrice != null ? Number(p.entryPrice) : null,
      exitPrice: p.closePrice != null ? Number(p.closePrice) : null,
      maxPositionSize: p.maxPositionQty != null ? Number(p.maxPositionQty) : null,
      closedSize: p.closedQty != null ? Number(p.closedQty) : null,
      pnlUsd: p.pnl != null ? Number(p.pnl) : null,
      pnlPct: p.roi != null ? Number(p.roi) * 100 : null,
      status: 'open', // positions endpoint returns current open positions
    }))
  } catch (err) {
    logger.warn(`[enrichment] Binance positions failed for ${traderId}: ${err}`)
    return []
  }
}

interface BinancePerformanceResponse {
  code?: string
  data?: {
    timeRange?: string
    roi?: number
    pnl?: number
    mdd?: number
    copierPnl?: number
    winRate?: number
    winOrders?: number
    totalOrder?: number
    sharpRatio?: number | null
  }
}

export async function fetchBinanceStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // GET performance endpoint (has winRate, mdd, tradeCount, copierPnl)
    // Ultra-short timeout: 8s for 90D data (VPS proxy tested <500ms)
    const perfData = await fetchWithProxyFallback<BinancePerformanceResponse>(
      `${BINANCE_PUBLIC}/lead-portfolio/performance?portfolioId=${traderId}&timeRange=90D`,
      { method: 'GET', timeoutMs: 8000 }
    )

    if (!perfData?.data) return null
    const d = perfData.data

    // Also fetch detail for AUM and follower count
    let aum: number | null = null
    let copiersCount: number | null = null
    try {
      const detailData = await fetchWithProxyFallback<Record<string, unknown>>(
        `${BINANCE_FRIENDLY}/lead-portfolio/detail?portfolioId=${traderId}`,
        { method: 'GET', timeoutMs: 5000 }
      )
      const dd = detailData?.data as Record<string, unknown> | null
      if (dd) {
        aum = dd.aum != null ? Number(dd.aum) : null
        copiersCount = dd.currentCopyCount != null ? Number(dd.currentCopyCount) : null
      }
    } catch {
      // Detail failed, continue with performance data only
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
    logger.warn(`[enrichment] Binance stats detail failed for ${traderId}: ${err}`)
    return null
  }
}

async function enrichSingleTrader(
  supabase: SupabaseClient,
  traderId: string,
  collectEquityCurve: boolean,
  collectPositionHistory: boolean,
): Promise<Result<string>> {
  try {
    if (collectEquityCurve) {
      const curve = await withRetry(
        () => fetchBinanceEquityCurve(traderId, '90D'),
        { maxRetries: 2, initialDelay: 2000, isRetryable: (e) => {
          const msg = e instanceof Error ? e.message : ''
          return msg.includes('timeout') || msg.includes('429') || msg.includes('ECONNRESET')
        }}
      )
      if (curve.length > 0) {
        await upsertEquityCurve(supabase, 'binance_futures', traderId, '90D', curve)
      }
    }

    if (collectPositionHistory) {
      const positions = await withRetry(
        () => fetchBinancePositionHistory(traderId),
        { maxRetries: 2, initialDelay: 2000, isRetryable: (e) => {
          const msg = e instanceof Error ? e.message : ''
          return msg.includes('timeout') || msg.includes('429') || msg.includes('ECONNRESET')
        }}
      )
      if (positions.length > 0) {
        await upsertPositionHistory(supabase, 'binance_futures', traderId, positions)
      }
    }

    return Ok(traderId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`[binance_futures] Enrichment failed for ${traderId}: ${msg}`)
    return Err(err instanceof Error ? err : new Error(msg))
  }
}

export async function enrichBinanceTraders(
  supabase: SupabaseClient,
  traderIds: string[],
  options: {
    concurrency?: number
    delayMs?: number
    collectEquityCurve?: boolean
    collectPositionHistory?: boolean
  } = {}
): Promise<{ success: number; failed: number; errors: string[] }> {
  const {
    concurrency = 3,
    delayMs = 1000,
    collectEquityCurve = true,
    collectPositionHistory = true,
  } = options

  let success = 0
  let failed = 0
  const errors: string[] = []

  for (let i = 0; i < traderIds.length; i += concurrency) {
    const batch = traderIds.slice(i, i + concurrency)

    const results = await Promise.allSettled(
      batch.map((traderId) =>
        enrichSingleTrader(supabase, traderId, collectEquityCurve, collectPositionHistory)
      )
    )

    for (const settledResult of results) {
      if (settledResult.status === 'fulfilled') {
        const result = settledResult.value
        if (result.ok) {
          success++
        } else {
          failed++
          if (errors.length < 10) errors.push(result.error.message)
        }
      } else {
        failed++
        const errorMsg = settledResult.reason instanceof Error
          ? settledResult.reason.message
          : String(settledResult.reason)
        if (errors.length < 10) errors.push(errorMsg)
      }
    }

    if (i + concurrency < traderIds.length) {
      await sleep(delayMs)
    }
  }

  return { success, failed, errors }
}
