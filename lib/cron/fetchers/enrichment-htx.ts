/**
 * HTX Futures Enrichment
 *
 * HTX API provides `profitList` (daily cumulative returns) in the ranking response.
 * We convert this into equity curve points for trader detail pages.
 *
 * Limitations:
 * - No dedicated equity curve API (derived from ranking data)
 * - No position history API
 * - No stats detail API beyond what ranking provides
 */

import type { EquityCurvePoint, StatsDetail } from './enrichment-types'
import { fetchJson, sleep } from './shared'
import { logger } from '@/lib/logger'

const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'

interface HtxRankItem {
  userSign?: string
  uid?: number
  nickName?: string
  winRate?: number
  mdd?: number
  profitList?: number[]
  copyUserNum?: number
  aum?: string | number
  tradeDays?: number
}

/**
 * Fetch equity curve for an HTX trader by finding them in the ranking
 * and converting their profitList to EquityCurvePoint[].
 */
export async function fetchHtxEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  const trader = await findTraderInRanking(traderId)
  if (!trader?.profitList || trader.profitList.length < 2) return []

  return convertProfitListToEquityCurve(trader.profitList, days)
}

/**
 * Fetch stats detail for an HTX trader from ranking data.
 */
export async function fetchHtxStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const trader = await findTraderInRanking(traderId)
  if (!trader) return null

  const winRate = trader.winRate != null ? Number(trader.winRate) * 100 : null
  const maxDrawdown = trader.mdd != null ? Number(trader.mdd) * 100 : null
  const aum = trader.aum != null ? Number(trader.aum) : null

  return {
    totalTrades: null,
    profitableTradesPct: winRate,
    avgHoldingTimeHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    sharpeRatio: null,
    maxDrawdown,
    currentDrawdown: null,
    volatility: null,
    copiersCount: trader.copyUserNum ?? null,
    copiersPnl: null,
    aum: aum && aum > 0 ? aum : null,
    winningPositions: null,
    totalPositions: null,
  }
}

/**
 * Convert HTX profitList (cumulative daily returns) to EquityCurvePoint[].
 * profitList values are cumulative decimal returns (e.g., 0.05 = 5% total return).
 */
function convertProfitListToEquityCurve(
  profitList: number[],
  days: number
): EquityCurvePoint[] {
  const relevantData = profitList.slice(-days)
  if (relevantData.length === 0) return []

  const todayMs = Date.now()
  const points: EquityCurvePoint[] = []

  for (let i = 0; i < relevantData.length; i++) {
    const date = new Date(todayMs - (relevantData.length - 1 - i) * 86400000)
    points.push({
      date: date.toISOString().split('T')[0],
      roi: relevantData[i] * 100, // Convert decimal to percentage
      pnl: null, // PnL not available per day
    })
  }

  return points
}

// Cache: traderId → HtxRankItem, refreshed per batch
const traderCache = new Map<string, HtxRankItem>()
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function findTraderInRanking(traderId: string): Promise<HtxRankItem | null> {
  // Return from cache if fresh
  if (traderCache.has(traderId) && Date.now() - cacheTimestamp < CACHE_TTL) {
    return traderCache.get(traderId) || null
  }

  // Fetch full ranking to populate cache
  await populateTraderCache()
  return traderCache.get(traderId) || null
}

async function populateTraderCache(): Promise<void> {
  if (Date.now() - cacheTimestamp < CACHE_TTL) return

  traderCache.clear()
  const maxPages = 10 // 500 traders max

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${API_URL}?rankType=1&pageNo=${page}&pageSize=50`
      const data = await fetchJson<{ code: number; data?: { itemList?: HtxRankItem[] } }>(url)

      if (data.code !== 200 || !data.data?.itemList) break
      const list = data.data.itemList
      if (list.length === 0) break

      for (const item of list) {
        const id = item.userSign || String(item.uid || '')
        if (id) traderCache.set(id, item)
      }

      if (list.length < 50) break
      await sleep(500)
    } catch (err) {
      logger.warn(`[htx_futures] Cache populate page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  cacheTimestamp = Date.now()
  logger.warn(`[htx_futures] Populated cache with ${traderCache.size} traders`)
}
