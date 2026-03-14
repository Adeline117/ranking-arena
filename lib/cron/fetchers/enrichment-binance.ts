/**
 * Binance enrichment: equity curve, position history, stats detail
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sleep } from './shared'
import { fetchWithProxyFallback, type EquityCurvePoint, type PositionHistoryItem, type StatsDetail } from './enrichment-types'
import { upsertEquityCurve, upsertPositionHistory } from './enrichment-db'
import { withRetry } from '@/lib/utils/circuit-breaker'
import { type Result, Ok, Err } from '@/lib/types'

const BINANCE_API = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade'

interface BinancePerformanceResponse {
  code?: string
  data?: {
    dailyPnls?: Array<{
      date: string
      pnl: string | number
      roi: string | number
    }>
  }
}

interface BinancePositionResponse {
  code?: string
  data?: {
    list?: Array<{
      symbol?: string
      direction?: string
      positionSide?: string
      entryPrice?: string | number
      closePrice?: string | number
      openTime?: number
      closeTime?: number
      maxPositionQty?: string | number
      closedQty?: string | number
      pnl?: string | number
      roi?: string | number
      marginType?: string
    }>
  }
}

export async function fetchBinanceEquityCurve(
  traderId: string,
  timeRange: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' = 'QUARTERLY'
): Promise<EquityCurvePoint[]> {
  try {
    // EMERGENCY FIX (2026-03-14): Reduce timeout from 15s → 8s to prevent accumulation
    // binance_spot was hanging 45-76min repeatedly due to slow/hung API calls
    const data = await fetchWithProxyFallback<BinancePerformanceResponse>(
      `${BINANCE_API}/lead-portfolio/query-performance`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: { portfolioId: traderId, timeRange },
        timeoutMs: 8000,  // Was 15000
      }
    )

    if (!data?.data?.dailyPnls) {
      logger.warn(`[enrichment] Binance equity curve empty for ${traderId}`)
      return []
    }

    return data.data.dailyPnls.map((d) => ({
      date: d.date,
      roi: Number(d.roi) * 100, // Convert decimal to percentage
      pnl: d.pnl != null ? Number(d.pnl) : null,
    }))
  } catch (err) {
    logger.warn(`[enrichment] Binance equity curve failed for ${traderId}: ${err}`)
    return []
  }
}

export async function fetchBinancePositionHistory(
  traderId: string,
  pageSize = 50
): Promise<PositionHistoryItem[]> {
  try {
    // EMERGENCY FIX (2026-03-14): Reduce timeout 15s → 8s
    const data = await fetchWithProxyFallback<BinancePositionResponse>(
      `${BINANCE_API}/lead-portfolio/query-position-history`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: { portfolioId: traderId, pageNumber: 1, pageSize },
        timeoutMs: 8000,  // Was 15000
      }
    )

    if (!data?.data?.list) {
      logger.warn(`[enrichment] Binance position history empty for ${traderId}`)
      return []
    }

    return data.data.list.map((p) => ({
      symbol: p.symbol || '',
      direction: (p.positionSide || p.direction || '').toLowerCase().includes('short')
        ? 'short'
        : 'long',
      positionType: 'perpetual',
      marginMode: p.marginType?.toLowerCase() || 'cross',
      openTime: p.openTime ? new Date(p.openTime).toISOString() : null,
      closeTime: p.closeTime ? new Date(p.closeTime).toISOString() : null,
      entryPrice: p.entryPrice != null ? Number(p.entryPrice) : null,
      exitPrice: p.closePrice != null ? Number(p.closePrice) : null,
      maxPositionSize: p.maxPositionQty != null ? Number(p.maxPositionQty) : null,
      closedSize: p.closedQty != null ? Number(p.closedQty) : null,
      pnlUsd: p.pnl != null ? Number(p.pnl) : null,
      pnlPct: p.roi != null ? Number(p.roi) * 100 : null,
      status: 'closed',
    }))
  } catch (err) {
    logger.warn(`[enrichment] Binance position history failed for ${traderId}: ${err}`)
    return []
  }
}

interface BinanceTraderStatsResponse {
  code?: string
  data?: {
    portfolioId?: string
    roi?: number
    pnl?: number
    winRate?: number
    maxDrawdown?: number
    mdd?: number
    followerCount?: number
    currentCopyCount?: number
    tradeCount?: number
    copierPnl?: number
    aum?: number
    leadingDays?: number
    avgHoldingTime?: number
  }
}

export async function fetchBinanceStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // EMERGENCY FIX (2026-03-14): Reduce timeout 15s → 8s
    const data = await fetchWithProxyFallback<BinanceTraderStatsResponse>(
      `${BINANCE_API}/lead-portfolio/query-lead-base-info`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.binance.com',
          Referer: 'https://www.binance.com/en/copy-trading',
        },
        body: { portfolioId: traderId },
        timeoutMs: 8000,  // Was 15000
      }
    )

    if (!data?.data) return null

    const d = data.data
    const positions = await fetchBinancePositionHistory(traderId, 100)

    let winningPositions = 0
    let totalProfit = 0
    let totalLoss = 0
    let profitCount = 0
    let lossCount = 0
    let largestWin = 0
    let largestLoss = 0
    let totalHoldingTime = 0
    let holdingTimeCount = 0

    for (const pos of positions) {
      if (pos.pnlUsd != null) {
        if (pos.pnlUsd > 0) {
          winningPositions++
          totalProfit += pos.pnlUsd
          profitCount++
          if (pos.pnlUsd > largestWin) largestWin = pos.pnlUsd
        } else if (pos.pnlUsd < 0) {
          totalLoss += Math.abs(pos.pnlUsd)
          lossCount++
          if (Math.abs(pos.pnlUsd) > largestLoss) largestLoss = Math.abs(pos.pnlUsd)
        }
      }
      if (pos.openTime && pos.closeTime) {
        const open = new Date(pos.openTime).getTime()
        const close = new Date(pos.closeTime).getTime()
        const hours = (close - open) / (1000 * 60 * 60)
        if (hours > 0 && hours < 720) {
          totalHoldingTime += hours
          holdingTimeCount++
        }
      }
    }

    return {
      totalTrades: d.tradeCount ?? positions.length,
      profitableTradesPct: d.winRate != null
        ? (d.winRate <= 1 ? d.winRate * 100 : d.winRate)
        : (positions.length > 0 ? (winningPositions / positions.length) * 100 : null),
      avgHoldingTimeHours: holdingTimeCount > 0 ? totalHoldingTime / holdingTimeCount : (d.avgHoldingTime ?? null),
      avgProfit: profitCount > 0 ? totalProfit / profitCount : null,
      avgLoss: lossCount > 0 ? totalLoss / lossCount : null,
      largestWin: largestWin > 0 ? largestWin : null,
      largestLoss: largestLoss > 0 ? largestLoss : null,
      sharpeRatio: null,
      maxDrawdown: d.maxDrawdown ?? d.mdd ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.followerCount ?? d.currentCopyCount ?? null,
      copiersPnl: d.copierPnl ?? null,
      aum: d.aum ?? null,
      winningPositions,
      totalPositions: positions.length,
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
        () => fetchBinanceEquityCurve(traderId, 'QUARTERLY'),
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
    
    logger.info(`Binance batch: ${success} success, ${failed} failed so far`)

    if (i + concurrency < traderIds.length) {
      await sleep(delayMs)
    }
  }

  return { success, failed, errors }
}
