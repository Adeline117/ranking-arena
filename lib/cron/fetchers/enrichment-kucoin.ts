/**
 * KuCoin enrichment — equity curve from totalPnlDate in leaderboard API
 *
 * KuCoin copy-trade API returns totalPnlDate (array of cumulative PnL values)
 * for each trader. We convert this into an equity curve and compute
 * WR/MDD/Sharpe from daily PnL deltas.
 *
 * Primary: VPS Playwright scraper /kucoin/trader-detail
 * Fallback: Direct KuCoin ct-copy-trade API
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

const VPS_BASE = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3457'
const VPS_KEY = (process.env.VPS_PROXY_KEY || '').trim()

interface KucoinTraderDetail {
  data?: {
    totalPnlDate?: number[] | string[]
    totalPnl?: number | string
    roi?: number | string
    winRate?: number | string
    maxDrawdown?: number | string
    followerCount?: number | string
    currentCopyCount?: number | string
    tradeCount?: number | string
    nickName?: string
  }
}

/**
 * Build equity curve from KuCoin's totalPnlDate array.
 * totalPnlDate is an array of cumulative PnL values (one per day).
 */
export async function fetchKucoinEquityCurve(
  traderId: string,
  days = 90
): Promise<EquityCurvePoint[]> {
  const detail = await fetchKucoinDetail(traderId)
  const pnlDates = detail?.data?.totalPnlDate
  if (!Array.isArray(pnlDates) || pnlDates.length < 2) return []

  const values = pnlDates.map(Number).filter(v => !isNaN(v))
  if (values.length < 2) return []

  // Take last N days
  const slice = values.slice(-days)
  const baseValue = slice[0]
  const today = new Date()

  return slice.map((v, i) => {
    const date = new Date(today.getTime() - (slice.length - 1 - i) * 86400000)
    return {
      date: date.toISOString().split('T')[0],
      // ROI as % change from first point
      roi: baseValue !== 0 ? ((v - baseValue) / Math.abs(baseValue)) * 100 : 0,
      pnl: v,
    }
  })
}

/**
 * Fetch stats from KuCoin trader detail.
 * Metrics from API: winRate, maxDrawdown, tradeCount.
 * Sharpe/WR/MDD also computed from equity curve by enrichment-runner.
 */
export async function fetchKucoinStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const detail = await fetchKucoinDetail(traderId)
  const d = detail?.data
  if (!d) return null

  const n = (v: unknown): number | null => {
    if (v == null) return null
    const x = Number(v)
    return isNaN(x) ? null : x
  }

  const winRate = n(d.winRate)
  const maxDrawdown = n(d.maxDrawdown)

  return {
    totalTrades: d.tradeCount != null ? Math.round(Number(d.tradeCount)) : null,
    profitableTradesPct: winRate != null ? (Math.abs(winRate) <= 1 ? winRate * 100 : winRate) : null,
    avgHoldingTimeHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    sharpeRatio: null, // Computed from equity curve by enrichment-runner
    maxDrawdown: maxDrawdown != null ? (Math.abs(maxDrawdown) <= 1 ? maxDrawdown * 100 : maxDrawdown) : null,
    currentDrawdown: null,
    volatility: null,
    copiersCount: n(d.currentCopyCount),
    copiersPnl: null,
    aum: null,
    winningPositions: null,
    totalPositions: null,
  }
}

async function fetchKucoinDetail(traderId: string): Promise<KucoinTraderDetail | null> {
  // Strategy 1: VPS Playwright scraper
  try {
    const data = await fetchJson<KucoinTraderDetail>(
      `${VPS_BASE}/kucoin/trader-detail?id=${encodeURIComponent(traderId)}`,
      {
        timeoutMs: 30000,
        headers: VPS_KEY ? { 'x-api-key': VPS_KEY } : undefined,
      }
    )
    if (data?.data?.totalPnlDate) return data
  } catch (err) {
    logger.warn(`[enrichment] KuCoin VPS detail failed for ${traderId}: ${err}`)
  }

  // Strategy 2: Direct API (may work from residential IPs)
  try {
    const data = await fetchJson<KucoinTraderDetail>(
      `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/detail?leadConfigId=${encodeURIComponent(traderId)}`,
      { timeoutMs: 15000 }
    )
    if (data?.data) return data
  } catch (err) {
    logger.warn(`[enrichment] KuCoin direct detail failed for ${traderId}: ${err}`)
  }

  return null
}
