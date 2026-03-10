/**
 * DEX enrichment: Hyperliquid + GMX
 * - Position history (existing)
 * - Equity curves (new: derived from portfolio snapshots / fills)
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'

// ============================================
// Hyperliquid Position History (from userFills)
// ============================================

interface HyperliquidFill {
  coin?: string
  px?: string
  sz?: string
  side?: string
  time?: number
  dir?: string
  closedPnl?: string
  crossed?: boolean
  startPosition?: string
}

export async function fetchHyperliquidPositionHistory(
  address: string,
  limit = 200
): Promise<PositionHistoryItem[]> {
  try {
    const fills = await fetchJson<HyperliquidFill[]>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { type: 'userFills', user: address },
        timeoutMs: 15000,
      }
    )

    if (!Array.isArray(fills) || fills.length === 0) return []

    const closingFills = fills
      .filter((f) => {
        const pnl = parseFloat(f.closedPnl || '0')
        return pnl !== 0
      })
      .slice(0, limit)

    return closingFills.map((f) => {
      const dir = (f.dir || '').toLowerCase()
      const isShort = dir.includes('short') || (dir === 'buy' && parseFloat(f.startPosition || '0') < 0)

      return {
        symbol: (f.coin || '').replace('@', 'HL-'),
        direction: isShort ? 'short' as const : 'long' as const,
        positionType: 'perpetual',
        marginMode: f.crossed ? 'cross' : 'isolated',
        openTime: null,
        closeTime: f.time ? new Date(f.time).toISOString() : null,
        entryPrice: null,
        exitPrice: f.px != null ? Number(f.px) : null,
        maxPositionSize: null,
        closedSize: f.sz != null ? Number(f.sz) : null,
        pnlUsd: f.closedPnl != null ? Number(f.closedPnl) : null,
        pnlPct: null,
        status: 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid position history failed: ${err}`)
    return []
  }
}

// ============================================
// GMX Position History (from GraphQL)
// ============================================

const GMX_SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const GMX_VALUE_SCALE = 1e30

export async function fetchGmxPositionHistory(
  address: string,
  limit = 50
): Promise<PositionHistoryItem[]> {
  try {
    const query = `{
      tradeActions(
        limit: ${limit},
        where: {
          account_eq: "${address}"
          orderType_in: [2, 4, 7]
        },
        orderBy: timestamp_DESC
      ) {
        timestamp
        orderType
        sizeDeltaUsd
        executionPrice
        isLong
        marketAddress
        basePnlUsd
      }
    }`

    const result = await fetchJson<{
      data?: {
        tradeActions?: Array<{
          timestamp: number
          orderType: number
          sizeDeltaUsd?: string
          executionPrice?: string
          isLong: boolean
          marketAddress?: string
          basePnlUsd?: string
        }>
      }
    }>(GMX_SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { query },
      timeoutMs: 20000,
    })

    const actions = result?.data?.tradeActions
    if (!actions || actions.length === 0) return []

    const closingActions = actions.filter((a) => {
      if (!a.basePnlUsd) return false
      try {
        return Number(BigInt(a.basePnlUsd)) / GMX_VALUE_SCALE !== 0
      } catch (err) {
        logger.warn(`[enrichment] Error: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    })

    return closingActions.map((a) => {
      const pnlUsd = a.basePnlUsd ? Number(BigInt(a.basePnlUsd)) / GMX_VALUE_SCALE : null
      const sizeUsd = a.sizeDeltaUsd ? Number(BigInt(a.sizeDeltaUsd)) / GMX_VALUE_SCALE : null
      const price = a.executionPrice ? Number(BigInt(a.executionPrice)) / 1e24 : null

      return {
        symbol: a.marketAddress?.slice(0, 10) || 'GMX',
        direction: a.isLong ? 'long' as const : 'short' as const,
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: null,
        closeTime: new Date(a.timestamp * 1000).toISOString(),
        entryPrice: null,
        exitPrice: price,
        maxPositionSize: sizeUsd,
        closedSize: sizeUsd,
        pnlUsd,
        pnlPct: sizeUsd && pnlUsd ? (pnlUsd / sizeUsd) * 100 : null,
        status: 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[enrichment] GMX position history failed: ${err}`)
    return []
  }
}

// ============================================
// Hyperliquid Equity Curve (from daily PnL fills)
// ============================================

/**
 * Build equity curve from Hyperliquid fills by aggregating daily PnL.
 * Uses the same userFills endpoint as position history.
 */
export async function fetchHyperliquidEquityCurve(
  address: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const fills = await fetchJson<HyperliquidFill[]>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { type: 'userFills', user: address },
        timeoutMs: 15000,
      }
    )

    if (!Array.isArray(fills) || fills.length === 0) return []

    // Aggregate closedPnl by day
    const cutoff = Date.now() - days * 86400000
    const dailyPnl = new Map<string, number>()

    for (const f of fills) {
      if (!f.time || f.time < cutoff) continue
      const pnl = parseFloat(f.closedPnl || '0')
      if (pnl === 0) continue
      const date = new Date(f.time).toISOString().split('T')[0]
      dailyPnl.set(date, (dailyPnl.get(date) || 0) + pnl)
    }

    if (dailyPnl.size === 0) return []

    // Convert to cumulative ROI curve (estimate initial capital from total volume)
    const sortedDates = [...dailyPnl.keys()].sort()
    let cumPnl = 0
    const points: EquityCurvePoint[] = []

    for (const date of sortedDates) {
      cumPnl += dailyPnl.get(date) || 0
      points.push({ date, roi: 0, pnl: cumPnl })
    }

    // Estimate ROI from cumulative PnL (rough: use first day PnL as ~1% of capital)
    const firstDayPnl = Math.abs(dailyPnl.get(sortedDates[0]) || 1)
    const estimatedCapital = firstDayPnl * 100 // Assume ~1% daily moves
    if (estimatedCapital > 0) {
      for (const p of points) {
        p.roi = ((p.pnl || 0) / estimatedCapital) * 100
      }
    }

    return points
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid equity curve failed: ${err}`)
    return []
  }
}

/**
 * Hyperliquid stats from clearinghouse state.
 */
export async function fetchHyperliquidStatsDetail(
  address: string
): Promise<StatsDetail | null> {
  try {
    const state = await fetchJson<{
      marginSummary?: { accountValue?: string; totalMarginUsed?: string }
      assetPositions?: Array<{ position?: { unrealizedPnl?: string; positionValue?: string } }>
    }>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { type: 'clearinghouseState', user: address },
        timeoutMs: 10000,
      }
    )

    if (!state?.marginSummary) return null

    const accountValue = parseFloat(state.marginSummary.accountValue || '0')
    const totalPositions = state.assetPositions?.length || 0

    return {
      totalTrades: null,
      profitableTradesPct: null,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: accountValue > 0 ? accountValue : null,
      winningPositions: null,
      totalPositions: totalPositions > 0 ? totalPositions : null,
    }
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid stats failed: ${err}`)
    return null
  }
}
