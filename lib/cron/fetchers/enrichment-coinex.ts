/**
 * CoinEx Enrichment
 *
 * CoinEx provides a public trader detail API:
 * GET https://www.coinex.com/res/copy-trading/public/traders?page=1&limit=50&sort_by=roi&period={period}
 * - Returns roi, win_rate, max_drawdown, follower_count, profit data
 * - Geo-blocked from some regions — uses VPS proxy fallback
 *
 * Notes:
 * - No dedicated detail endpoint — data from ranking list
 * - CoinEx does NOT support 90d window (only 7d, 30d)
 * - ~175 traders total across 4 pages
 * - roi and win_rate in decimal format (×100 for %)
 */

import type { EquityCurvePoint, StatsDetail } from './enrichment-types'
import { fetchWithProxyFallback } from './enrichment-types'
import { sleep } from './shared'
import { logger } from '@/lib/logger'

const LIST_URL = 'https://www.coinex.com/res/copy-trading/public/traders'

interface CoinexTraderItem {
  trader_id?: string
  traderId?: string
  uid?: string
  nick_name?: string
  nickname?: string
  avatar?: string
  roi?: number          // Decimal (0.25 = 25%)
  roi_rate?: number
  return_rate?: number
  profit_amount?: number
  pnl?: number
  profit?: number
  total_pnl_amount?: number
  win_rate?: number     // Decimal (0.65 = 65%)
  winRate?: number
  winning_rate?: number
  max_drawdown?: number // Decimal (0.1 = 10%)
  maxDrawdown?: number
  mdd?: number
  follower_count?: number
  followerCount?: number
  copier_num?: number
  cur_follower_num?: number
  profit_rate_series?: Array<[number, string]>
}

/**
 * Fetch equity curve for a CoinEx trader.
 * CoinEx ranking does not include daily data, so we return empty
 * and let the enrichment runner fall back to DB snapshots.
 */
export async function fetchCoinexEquityCurve(
  _traderId: string,
  _days: number
): Promise<EquityCurvePoint[]> {
  // CoinEx API does not provide historical daily data
  // The enrichment runner will fall back to buildEquityCurveFromSnapshots()
  return []
}

/**
 * Fetch stats detail for a CoinEx trader from ranking data.
 */
export async function fetchCoinexStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const trader = await findTraderInRanking(traderId)
  if (!trader) return null

  // ROI and rates are decimal format
  const rawWr = toNum(trader.win_rate ?? trader.winRate ?? trader.winning_rate)
  const winRate = rawWr != null ? (Math.abs(rawWr) <= 1 ? rawWr * 100 : rawWr) : null

  const rawMdd = toNum(trader.max_drawdown ?? trader.maxDrawdown ?? trader.mdd)
  const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

  const followers = toNum(
    trader.follower_count ?? trader.followerCount ?? trader.copier_num ?? trader.cur_follower_num
  )

  return {
    totalTrades: null,
    profitableTradesPct: winRate,
    avgHoldingTimeHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    sharpeRatio: (() => {
      const series = trader.profit_rate_series
      if (!Array.isArray(series) || series.length < 7) return null
      const roiValues = series.map(p => Number(p[1])).filter(n => !isNaN(n))
      if (roiValues.length < 7) return null
      const returns = roiValues.slice(1).map((v, i) => v - roiValues[i])
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
      if (std <= 0) return null
      const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
      return sharpe > -10 && sharpe < 10 ? sharpe : null
    })(),
    maxDrawdown,
    currentDrawdown: null,
    volatility: null,
    copiersCount: followers,
    copiersPnl: null,
    aum: null,
    winningPositions: null,
    totalPositions: null,
  }
}

function toNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

// Cache: traderId → CoinexTraderItem, refreshed per batch
const traderCache = new Map<string, CoinexTraderItem>()
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000

async function findTraderInRanking(traderId: string): Promise<CoinexTraderItem | null> {
  if (traderCache.has(traderId) && Date.now() - cacheTimestamp < CACHE_TTL) {
    return traderCache.get(traderId) || null
  }

  await populateTraderCache()
  return traderCache.get(traderId) || null
}

async function populateTraderCache(): Promise<void> {
  if (Date.now() - cacheTimestamp < CACHE_TTL) return

  traderCache.clear()
  const maxPages = 5 // ~250 traders max

  for (const period of ['30d', '7d']) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `${LIST_URL}?page=${page}&limit=50&sort_by=roi&period=${period}`
        const data = await fetchWithProxyFallback<{
          code: number
          data?: {
            data?: CoinexTraderItem[]
            items?: CoinexTraderItem[]
            has_next?: boolean
          }
        }>(url, { timeoutMs: 10000 })

        const list = data?.data?.data || data?.data?.items || []
        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          const id = String(item.trader_id || item.traderId || item.uid || '')
          if (id && !traderCache.has(id)) {
            traderCache.set(id, item)
          }
        }

        const hasNext = data?.data?.has_next ?? (list.length >= 50)
        if (!hasNext) break
        await sleep(800)
      } catch (err) {
        logger.warn(`[coinex] Cache populate page ${page} (${period}) failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
  }

  cacheTimestamp = Date.now()
  logger.warn(`[coinex] Populated cache with ${traderCache.size} traders`)
}
