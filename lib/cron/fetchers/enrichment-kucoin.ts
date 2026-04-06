/**
 * KuCoin enrichment — equity curve from totalPnlDate in leaderboard API
 *
 * Strategy: Fetch leaderboard page (contains totalPnlDate for each trader),
 * cache the full page, then extract per-trader data.
 * VPS scraper only has /kucoin/leaderboard (no /trader-detail route).
 *
 * totalPnlDate is an array of cumulative PnL values (one per day, ~30 entries).
 * WR/MDD/Sharpe are computed from daily PnL deltas by enrichment-runner.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

const VPS_BASE = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3457'
const VPS_KEY = (process.env.VPS_PROXY_KEY || '').trim()

// Cache leaderboard data to avoid re-fetching per trader
let cachedLeaderboard: Map<string, KucoinTrader> | null = null
let cacheExpiry = 0

interface KucoinTrader {
  leadConfigId?: string
  uid?: string
  nickName?: string
  totalPnlDate?: number[] | string[]
  totalPnl?: number | string
  totalPnlRatio?: number | string
  currentCopyUserCount?: number | string
  maxCopyUserCount?: number | string
  leadPrincipal?: number | string
  [key: string]: unknown
}

async function getLeaderboardCache(): Promise<Map<string, KucoinTrader>> {
  if (cachedLeaderboard && Date.now() < cacheExpiry) return cachedLeaderboard

  const traders = new Map<string, KucoinTrader>()

  // Fetch multiple pages to cover more traders
  for (let page = 1; page <= 5; page++) {
    try {
      // Strategy 1: VPS scraper (primary)
      const data = await fetchJson<Record<string, unknown>>(
        `${VPS_BASE}/kucoin/leaderboard?pageNo=${page}&pageSize=50`,
        {
          timeoutMs: 60000,
          headers: VPS_KEY ? { 'x-proxy-key': VPS_KEY } : undefined,
        }
      )

      const dataObj = (data?.data ?? data) as Record<string, unknown>
      const items = (dataObj?.items || dataObj?.list || dataObj?.rows ||
        (Array.isArray(dataObj) ? dataObj : [])) as KucoinTrader[]

      if (!items.length) break

      for (const item of items) {
        const id = String(item.leadConfigId || item.uid || '')
        if (id) traders.set(id, item)
      }

      if (items.length < 50) break
    } catch (err) {
      logger.warn(`[enrichment] KuCoin leaderboard page ${page} failed: ${err}`)
      if (page === 1 && traders.size === 0) {
        // Try direct API fallback
        try {
          const data = await fetchJson<Record<string, unknown>>(
            `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US&pageNo=${page}&pageSize=50`,
            { timeoutMs: 15000 }
          )
          const items = ((data?.data as Record<string, unknown>)?.items ||
            (data?.data as unknown[])) as KucoinTrader[] | undefined
          if (Array.isArray(items)) {
            for (const item of items) {
              const id = String(item.leadConfigId || item.uid || '')
              if (id) traders.set(id, item)
            }
          }
        } catch (err) {
          logger.warn('[enrichment-kucoin] direct API fallback failed:', err instanceof Error ? err.message : String(err))
        }
      }
      break
    }
  }

  if (traders.size > 0) {
    cachedLeaderboard = traders
    cacheExpiry = Date.now() + 30 * 60 * 1000 // Cache for 30 min
    logger.info(`[enrichment] KuCoin leaderboard cached: ${traders.size} traders`)
  }

  return traders
}

/**
 * Build equity curve from KuCoin's totalPnlDate array.
 * totalPnlDate is an array of cumulative PnL values (one per day).
 *
 * ROI is computed relative to the first point. When the first PnL is 0,
 * we use the cumulative PnL directly as the ROI proxy so that downstream
 * metric derivation (Sharpe, MDD) still works instead of getting all-zero ROI.
 */
export async function fetchKucoinEquityCurve(
  traderId: string,
  days = 90
): Promise<EquityCurvePoint[]> {
  const cache = await getLeaderboardCache()
  const trader = cache.get(traderId)
  const pnlDates = trader?.totalPnlDate

  if (!Array.isArray(pnlDates) || pnlDates.length < 2) return []

  const values = pnlDates.map(Number).filter(v => !isNaN(v))
  if (values.length < 2) return []

  const slice = values.slice(-days)
  const baseValue = slice[0]
  const today = new Date()

  return slice.map((v, i) => {
    const date = new Date(today.getTime() - (slice.length - 1 - i) * 86400000)
    // When baseValue is 0, use cumulative PnL delta from first point as ROI proxy.
    // This ensures downstream Sharpe/MDD computations see non-zero daily returns.
    const roi = baseValue !== 0
      ? ((v - baseValue) / Math.abs(baseValue)) * 100
      : (v - slice[0])
    return {
      date: date.toISOString().split('T')[0],
      roi,
      pnl: v,
    }
  })
}

/**
 * Fetch stats from KuCoin leaderboard cache.
 * Compute WR/MDD from totalPnlDate daily deltas.
 */
export async function fetchKucoinStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const cache = await getLeaderboardCache()
  const d = cache.get(traderId)
  if (!d) return null

  // Compute derived metrics from totalPnlDate
  const pnlDates = d.totalPnlDate
  let winRate: number | null = null
  let maxDrawdown: number | null = null
  let sharpeRatio: number | null = null
  let tradesCount: number | null = null

  if (Array.isArray(pnlDates) && pnlDates.length >= 3) {
    const values = pnlDates.map(Number).filter(v => !isNaN(v))

    // Daily returns (deltas)
    const returns: number[] = []
    for (let i = 1; i < values.length; i++) {
      returns.push(values[i] - values[i - 1])
    }
    tradesCount = returns.length

    // Win rate: % of positive daily returns
    if (returns.length >= 3) {
      const wins = returns.filter(r => r > 0).length
      winRate = Math.round((wins / returns.length) * 10000) / 100
    }

    // Max drawdown from cumulative PnL curve
    let peak = -Infinity
    let maxDD = 0
    for (const v of values) {
      if (v > peak) peak = v
      const dd = peak > 0 ? ((peak - v) / peak) * 100 : 0
      if (dd > maxDD) maxDD = dd
    }
    if (maxDD > 0 && maxDD <= 100) maxDrawdown = Math.round(maxDD * 100) / 100

    // Sharpe ratio (annualized)
    if (returns.length >= 2) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
      if (std > 0) sharpeRatio = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
    }
  }

  const n = (v: unknown): number | null => {
    if (v == null) return null
    const x = Number(v)
    return isNaN(x) ? null : x
  }

  return {
    totalTrades: tradesCount,
    profitableTradesPct: winRate,
    avgHoldingTimeHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    sharpeRatio,
    maxDrawdown,
    currentDrawdown: null,
    volatility: null,
    copiersCount: n(d.currentCopyUserCount),
    copiersPnl: null,
    aum: n(d.leadPrincipal),
    winningPositions: null,
    totalPositions: null,
  }
}
