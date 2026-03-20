/**
 * Weex enrichment — equity curve from ndaysReturnRates in leaderboard response
 *
 * Weex leaderboard returns ndaysReturnRates: 30-day daily return rate array.
 * We re-fetch the leaderboard via VPS scraper and extract the curve.
 */

import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

const VPS_SCRAPER_URL = () => (process.env.VPS_SCRAPER_SG || process.env.VPS_PROXY_SG || '').replace(/\n$/, '').trim()
const VPS_PROXY_KEY = () => (process.env.VPS_PROXY_KEY || '').trim()

export async function fetchWeexEquityCurve(
  traderId: string,
  _days = 30
): Promise<EquityCurvePoint[]> {
  try {
    const host = VPS_SCRAPER_URL()
    const key = VPS_PROXY_KEY()
    if (!host || !key) return []

    // Fetch leaderboard to find this trader's ndaysReturnRates
    const res = await fetch(`${host}/weex/leaderboard?pageSize=100`, {
      headers: { 'X-Proxy-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(90000),
    })
    if (!res.ok) return []

    const vpsData = await res.json() as Record<string, unknown>
    const dataArr = vpsData?.data as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(dataArr)) return []

    // Find the trader across all tabs
    let ndaysReturnRates: number[] | null = null
    for (const section of dataArr) {
      const list = (section?.list || []) as Array<Record<string, unknown>>
      const found = list.find(t => String(t.traderUserId) === traderId)
      if (found?.ndaysReturnRates && Array.isArray(found.ndaysReturnRates)) {
        ndaysReturnRates = found.ndaysReturnRates as number[]
        break
      }
    }

    if (!ndaysReturnRates?.length) return []

    // Convert daily return rates to cumulative equity curve
    const now = new Date()
    let cumulativeRoi = 0
    return ndaysReturnRates.map((rate, i) => {
      cumulativeRoi += Number(rate) || 0
      const date = new Date(now)
      date.setDate(date.getDate() - (ndaysReturnRates!.length - 1 - i))
      return {
        date: date.toISOString().split('T')[0],
        roi: cumulativeRoi,
        pnl: null,
      }
    })
  } catch (err) {
    logger.warn(`[enrichment] Weex equity curve failed: ${err}`)
    return []
  }
}

export async function fetchWeexStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const host = VPS_SCRAPER_URL()
    const key = VPS_PROXY_KEY()
    if (!host || !key) return null

    const res = await fetch(`${host}/weex/leaderboard?pageSize=100`, {
      headers: { 'X-Proxy-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(90000),
    })
    if (!res.ok) return null

    const vpsData = await res.json() as Record<string, unknown>
    const dataArr = vpsData?.data as Array<Record<string, unknown>> | undefined
    if (!Array.isArray(dataArr)) return null

    let trader: Record<string, unknown> | null = null
    for (const section of dataArr) {
      const list = (section?.list || []) as Array<Record<string, unknown>>
      const found = list.find(t => String(t.traderUserId) === traderId)
      if (found) { trader = found; break }
    }
    if (!trader) return null

    // Extract win rate and max drawdown from leaderboard data
    // Weex leaderboard response contains these in various field names
    const winRate = safeNum(trader.winRate ?? trader.win_rate ?? trader.winningRate)
    const maxDrawdown = safeNum(trader.maxDrawdown ?? trader.max_drawdown ?? trader.maxBackRate)
    const tradeCount = safeNum(trader.tradeCount ?? trader.totalOrderNum ?? trader.orderCount)

    return {
      totalTrades: tradeCount,
      profitableTradesPct: winRate != null ? (Math.abs(winRate) <= 1 ? winRate * 100 : winRate) : null,
      avgHoldingTimeHours: null,
      avgProfit: null, avgLoss: null,
      largestWin: null, largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: maxDrawdown != null ? Math.abs(maxDrawdown <= 1 ? maxDrawdown * 100 : maxDrawdown) : null,
      currentDrawdown: null, volatility: null,
      copiersCount: trader.followCount != null ? Number(trader.followCount) : null,
      copiersPnl: null,
      aum: null,
      winningPositions: null, totalPositions: tradeCount,
    }
  } catch (err) {
    logger.warn(`[enrichment] Weex stats detail failed: ${err}`)
    return null
  }
}
