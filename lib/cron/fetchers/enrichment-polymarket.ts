/**
 * Polymarket Enrichment
 *
 * Polymarket provides public APIs for:
 * 1. Leaderboard: GET /v1/leaderboard?timePeriod={period}&user={wallet}
 *    - PnL and volume per period
 * 2. Positions: GET /positions?user={wallet}
 *    - Current open positions with PnL
 * 3. Closed positions: GET /closed-positions?user={wallet}
 *    - Historical closed positions with realized PnL
 * 4. Portfolio value: GET /value?user={wallet}
 *
 * Notes:
 * - No auth required
 * - trader_key = proxy wallet address (0x...)
 * - Prediction market — positions are event outcomes, not trading pairs
 */

import type { EquityCurvePoint, StatsDetail, PortfolioPosition, PositionHistoryItem } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const DATA_API = 'https://data-api.polymarket.com'

/**
 * Build equity curve from Polymarket on-chain activity (trades + redemptions).
 * Aggregates daily USDC flows into cumulative PnL curve.
 */
export async function fetchPolymarketEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const startTs = Math.floor((Date.now() - days * 86400000) / 1000)

    // Fetch all activity (trades, redemptions, rewards) in the period
    const allActivity: Array<Record<string, unknown>> = []
    let offset = 0
    const pageSize = 500

    while (offset < 5000) { // Safety cap
      const data = await fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/activity?user=${traderId}&limit=${pageSize}&offset=${offset}&start=${startTs}`,
        { timeoutMs: 15000 }
      )
      if (!Array.isArray(data) || data.length === 0) break
      allActivity.push(...data)
      if (data.length < pageSize) break
      offset += pageSize
    }

    if (allActivity.length === 0) return []

    // Group by day and compute daily net PnL
    const dailyPnl = new Map<string, number>()

    for (const act of allActivity) {
      const ts = num(act.timestamp)
      if (ts == null) continue
      const date = new Date(ts * 1000).toISOString().split('T')[0]
      const usdcSize = num(act.usdcSize) ?? 0
      const side = String(act.side || '')
      const type = String(act.type || '')

      // Net flow: SELL/REDEEM = money in (+), BUY = money out (-)
      let flow = 0
      if (type === 'TRADE') {
        flow = side === 'SELL' ? usdcSize : -usdcSize
      } else if (type === 'REDEEM' || type === 'REWARD' || type === 'MAKER_REBATE') {
        flow = usdcSize
      } else if (type === 'SPLIT' || type === 'MERGE') {
        // Neutral operations
        flow = 0
      }

      dailyPnl.set(date, (dailyPnl.get(date) || 0) + flow)
    }

    // Sort by date and build cumulative curve
    const sortedDates = Array.from(dailyPnl.keys()).sort()
    let cumPnl = 0
    const points: EquityCurvePoint[] = []

    for (const date of sortedDates) {
      cumPnl += dailyPnl.get(date)!
      points.push({
        date,
        roi: 0, // Cannot compute ROI without initial capital — set in enrichment-runner
        pnl: Math.round(cumPnl * 100) / 100,
      })
    }

    return points
  } catch (err) {
    logger.warn(`[polymarket] Equity curve failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch stats detail for a Polymarket trader.
 * Combines leaderboard data (PnL, volume) with position counts.
 */
export async function fetchPolymarketStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Fetch ALL-time leaderboard entry for this user
    const [lbAll, lbMonth, positions, closedPositions] = await Promise.all([
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/v1/leaderboard?timePeriod=ALL&user=${traderId}&limit=1`,
        { timeoutMs: 10000 }
      ).catch(() => null),
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/v1/leaderboard?timePeriod=MONTH&user=${traderId}&limit=1`,
        { timeoutMs: 10000 }
      ).catch(() => null),
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/positions?user=${traderId}&limit=500`,
        { timeoutMs: 10000 }
      ).catch(() => null),
      fetchJson<Array<Record<string, unknown>>>(
        `${DATA_API}/closed-positions?user=${traderId}&limit=500`,
        { timeoutMs: 10000 }
      ).catch(() => null),
    ])

    const entry = Array.isArray(lbAll) && lbAll.length > 0 ? lbAll[0] : null
    const _monthEntry = Array.isArray(lbMonth) && lbMonth.length > 0 ? lbMonth[0] : null
    const openPositions = Array.isArray(positions) ? positions : []
    const closedPos = Array.isArray(closedPositions) ? closedPositions : []

    const pnl = entry ? num(entry.pnl) : null
    const volume = entry ? num(entry.vol) : null
    const totalPositions = openPositions.length + closedPos.length

    // Compute win rate from closed positions
    let wins = 0
    let totalClosed = 0
    for (const pos of closedPos) {
      const realizedPnl = num(pos.realizedPnl)
      if (realizedPnl != null) {
        totalClosed++
        if (realizedPnl > 0) wins++
      }
    }
    const profitableTradesPct = totalClosed > 0
      ? Math.round((wins / totalClosed) * 1000) / 10
      : null

    // Compute ROI from PnL / volume
    let roi: number | null = null
    if (pnl != null && volume != null && volume > 0) {
      roi = Math.round((pnl / volume) * 100 * 100) / 100
      roi = Math.max(-500, Math.min(10000, roi))
    }

    // AUM from current positions
    let aum: number | null = null
    for (const pos of openPositions) {
      const currentValue = num(pos.currentValue)
      if (currentValue != null) {
        aum = (aum || 0) + currentValue
      }
    }

    // Compute Sharpe from daily PnL activity
    let sharpeRatio: number | null = null
    try {
      const startTs90d = Math.floor((Date.now() - 90 * 86400000) / 1000)
      const allActivity: Array<Record<string, unknown>> = []
      let actOffset = 0
      while (actOffset < 5000) {
        const actData = await fetchJson<Array<Record<string, unknown>>>(
          `${DATA_API}/activity?user=${traderId}&limit=500&offset=${actOffset}&start=${startTs90d}`,
          { timeoutMs: 15000 }
        ).catch(() => null)
        if (!Array.isArray(actData) || actData.length === 0) break
        allActivity.push(...actData)
        if (actData.length < 500) break
        actOffset += 500
      }
      if (allActivity.length > 0) {
        const dailyPnlMap = new Map<string, number>()
        for (const act of allActivity) {
          const ts = num(act.timestamp)
          if (ts == null) continue
          const date = new Date(ts * 1000).toISOString().split('T')[0]
          const usdcSize = num(act.usdcSize) ?? 0
          const side = String(act.side || '')
          const type = String(act.type || '')
          let flow = 0
          if (type === 'TRADE') flow = side === 'SELL' ? usdcSize : -usdcSize
          else if (type === 'REDEEM' || type === 'REWARD' || type === 'MAKER_REBATE') flow = usdcSize
          dailyPnlMap.set(date, (dailyPnlMap.get(date) || 0) + flow)
        }
        const dailyReturns = Array.from(dailyPnlMap.values())
        if (dailyReturns.length >= 7) {
          const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
          const std = Math.sqrt(dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / dailyReturns.length)
          if (std > 0) {
            const s = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
            if (s > -20 && s < 20) sharpeRatio = s
          }
        }
      }
    } catch {
      // Non-critical — proceed without Sharpe
    }

    return {
      totalTrades: totalClosed > 0 ? totalClosed : null,
      profitableTradesPct,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio,
      maxDrawdown: null,
      currentDrawdown: null,
      volatility: null,
      roi,
      pnl,
      copiersCount: null,
      copiersPnl: null,
      aum: aum != null ? Math.round(aum * 100) / 100 : null,
      winningPositions: wins > 0 ? wins : null,
      totalPositions: totalPositions > 0 ? totalPositions : null,
    }
  } catch (err) {
    logger.warn(`[polymarket] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Fetch current open positions from Polymarket.
 */
export async function fetchPolymarketCurrentPositions(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const data = await fetchJson<Array<Record<string, unknown>>>(
      `${DATA_API}/positions?user=${traderId}&limit=100&sizeThreshold=1`,
      { timeoutMs: 10000 }
    )

    if (!Array.isArray(data) || data.length === 0) return []

    return data.map((pos) => ({
      symbol: String(pos.title || pos.slug || `Market#${pos.conditionId}`).slice(0, 60),
      direction: String(pos.outcome || 'Yes').toLowerCase() === 'no' ? 'short' as const : 'long' as const,
      investedPct: num(pos.initialValue) != null && num(pos.currentValue) != null
        ? null // Can't derive percentage without total portfolio
        : null,
      entryPrice: num(pos.avgPrice),
      pnl: num(pos.cashPnl),
    }))
  } catch (err) {
    logger.warn(`[polymarket] Positions failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch closed position history from Polymarket.
 */
export async function fetchPolymarketPositionHistory(
  traderId: string
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchJson<Array<Record<string, unknown>>>(
      `${DATA_API}/closed-positions?user=${traderId}&limit=100&sortBy=REALIZEDPNL`,
      { timeoutMs: 10000 }
    )

    if (!Array.isArray(data) || data.length === 0) return []

    return data.map((pos) => ({
      symbol: String(pos.title || pos.slug || `Market#${pos.conditionId}`).slice(0, 60),
      direction: String(pos.outcome || 'Yes').toLowerCase() === 'no' ? 'short' as const : 'long' as const,
      positionType: 'prediction',
      marginMode: 'isolated',
      openTime: null,
      closeTime: pos.timestamp ? String(pos.timestamp) : null,
      entryPrice: num(pos.avgPrice),
      exitPrice: num(pos.curPrice),
      maxPositionSize: num(pos.totalBought),
      closedSize: null,
      pnlUsd: num(pos.realizedPnl),
      pnlPct: null,
      status: 'closed',
    }))
  } catch (err) {
    logger.warn(`[polymarket] Position history failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

function num(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}
