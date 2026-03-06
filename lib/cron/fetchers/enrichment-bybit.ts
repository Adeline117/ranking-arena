/**
 * Bybit enrichment: equity curve, position history, stats detail
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sleep } from './shared'
import { fetchWithProxyFallback, type EquityCurvePoint, type PositionHistoryItem, type StatsDetail } from './enrichment-types'
import { upsertEquityCurve } from './enrichment-db'

interface BybitChartResponse {
  retCode?: number
  result?: {
    dataList?: Array<{
      date?: string
      value?: string | number
      pnl?: string | number
    }>
  }
}

export async function fetchBybitEquityCurve(
  traderId: string,
  days = 90
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchWithProxyFallback<BybitChartResponse>(
      'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-chart',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.bybit.com',
          Referer: 'https://www.bybit.com/copyTrade',
        },
        body: { leaderId: traderId, days },
        timeoutMs: 15000,
      }
    )

    if (data?.retCode !== 0 && data?.retCode !== undefined) {
      logger.warn(`[enrichment] Bybit equity curve API error for ${traderId}: retCode=${data.retCode}`)
      return []
    }

    if (!data?.result?.dataList) {
      logger.warn(`[enrichment] Bybit equity curve empty for ${traderId}`)
      return []
    }

    return data.result.dataList
      .filter((d) => d.date)
      .map((d) => ({
        date: d.date!,
        roi: d.value != null ? Number(d.value) : 0,
        pnl: d.pnl != null ? Number(d.pnl) : null,
      }))
  } catch (err) {
    logger.warn(`[enrichment] Bybit equity curve failed for ${traderId}: ${err}`)
    return []
  }
}

interface BybitHistoryOrderResponse {
  retCode?: number
  result?: {
    data?: Array<{
      symbol?: string
      side?: string
      entryPrice?: string | number
      closePrice?: string | number
      qty?: string | number
      closedSize?: string | number
      leverage?: string | number
      createdAt?: string | number
      closedAt?: string | number
      pnl?: string | number
      pnlRate?: string | number
    }>
  }
}

export async function fetchBybitPositionHistory(
  traderId: string,
  pageSize = 50
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchWithProxyFallback<BybitHistoryOrderResponse>(
      'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-history-order',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.bybit.com',
          Referer: 'https://www.bybit.com/copyTrade',
        },
        body: { leaderId: traderId, pageNo: 1, pageSize },
        timeoutMs: 15000,
      }
    )

    if (data?.retCode !== 0 && data?.retCode !== undefined) {
      logger.warn(`[enrichment] Bybit position history API error for ${traderId}: retCode=${data.retCode}`)
      return []
    }

    if (!data?.result?.data) {
      logger.warn(`[enrichment] Bybit position history empty for ${traderId}`)
      return []
    }

    return data.result.data.map((p) => ({
      symbol: p.symbol || '',
      direction: (p.side || '').toLowerCase().includes('sell') ? 'short' as const : 'long' as const,
      positionType: 'perpetual',
      marginMode: 'cross',
      openTime: p.createdAt ? new Date(Number(p.createdAt)).toISOString() : null,
      closeTime: p.closedAt ? new Date(Number(p.closedAt)).toISOString() : null,
      entryPrice: p.entryPrice != null ? Number(p.entryPrice) : null,
      exitPrice: p.closePrice != null ? Number(p.closePrice) : null,
      maxPositionSize: p.qty != null ? Number(p.qty) : null,
      closedSize: p.closedSize != null ? Number(p.closedSize) : null,
      pnlUsd: p.pnl != null ? Number(p.pnl) : null,
      pnlPct: p.pnlRate != null ? Number(p.pnlRate) * 100 : null,
      status: 'closed',
    }))
  } catch (err) {
    logger.warn(`[enrichment] Bybit position history failed for ${traderId}: ${err}`)
    return []
  }
}

interface BybitTraderDetailResponse {
  retCode?: number
  result?: {
    leaderId?: string
    nickName?: string
    roi?: string
    pnl?: string
    winRate?: string
    maxDrawdown?: string
    sharpeRatio?: string
    followerCount?: number
    copierPnl?: string
    aum?: string
    tradeCount?: number
    avgHoldingPeriod?: number // in seconds
    avgProfit?: string
    avgLoss?: string
  }
}

export async function fetchBybitStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchWithProxyFallback<BybitTraderDetailResponse>(
      `https://www.bybit.com/x-api/fapi/beehive/public/v1/common/leader-detail`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://www.bybit.com',
          Referer: 'https://www.bybit.com/copyTrade',
        },
        body: { leaderId: traderId },
        timeoutMs: 15000,
      }
    )

    if (data?.retCode !== 0 && data?.retCode !== undefined) {
      logger.warn(`[enrichment] Bybit stats detail API error for ${traderId}: retCode=${data.retCode}`)
      return null
    }

    if (!data?.result) {
      logger.warn(`[enrichment] Bybit stats detail empty for ${traderId}`)
      return null
    }

    const d = data.result
    const parseNum = (v: string | number | undefined): number | null => {
      if (v == null) return null
      const n = typeof v === 'string' ? parseFloat(v) : Number(v)
      return isNaN(n) ? null : n
    }

    return {
      totalTrades: d.tradeCount ?? null,
      profitableTradesPct: parseNum(d.winRate),
      avgHoldingTimeHours: d.avgHoldingPeriod ? d.avgHoldingPeriod / 3600 : null,
      avgProfit: parseNum(d.avgProfit),
      avgLoss: parseNum(d.avgLoss),
      largestWin: null,
      largestLoss: null,
      sharpeRatio: parseNum(d.sharpeRatio),
      maxDrawdown: parseNum(d.maxDrawdown),
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.followerCount ?? null,
      copiersPnl: parseNum(d.copierPnl),
      aum: parseNum(d.aum),
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] Bybit stats detail failed for ${traderId}: ${err}`)
    return null
  }
}

export async function enrichBybitTraders(
  supabase: SupabaseClient,
  traderIds: string[],
  options: {
    concurrency?: number
    delayMs?: number
  } = {}
): Promise<{ success: number; failed: number }> {
  const { concurrency = 3, delayMs = 1000 } = options

  let success = 0
  let failed = 0

  for (let i = 0; i < traderIds.length; i += concurrency) {
    const batch = traderIds.slice(i, i + concurrency)

    await Promise.all(
      batch.map(async (traderId) => {
        try {
          const curve = await fetchBybitEquityCurve(traderId, 90)
          if (curve.length > 0) {
            await upsertEquityCurve(supabase, 'bybit', traderId, '90D', curve)
          }
          success++
        } catch (err) {
          logger.warn(`[bybit] Equity curve fetch failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      })
    )

    if (i + concurrency < traderIds.length) {
      await sleep(delayMs)
    }
  }

  return { success, failed }
}
