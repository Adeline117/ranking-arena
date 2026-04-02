/**
 * BTCC Futures Enrichment
 *
 * BTCC's public leaderboard API includes `netProfitList` (30 daily PnL values)
 * for each trader, plus win_rate, mdd, and follower counts.
 *
 * Endpoint: POST https://www.btcc.com/documentary/trader/page
 * - No auth required
 * - 50/page, up to 1760 traders
 * - netProfitList: comma-separated cumulative PnL values (30 days)
 * - rateProfit: ROI percentage
 * - maxBackRate: MDD in basis points (÷100 for %)
 * - winRate: already percentage
 *
 * No dedicated detail API — all data extracted from ranking list.
 */

import type { EquityCurvePoint, StatsDetail } from './enrichment-types'
import { fetchJson, sleep } from './shared'
import { logger } from '@/lib/logger'

const API_URL = 'https://www.btcc.com/documentary/trader/page'

interface BtccRankItem {
  traderId: number | string
  nickName?: string
  avatarPic?: string | null
  followNum?: number
  totalNetProfit?: number
  rateProfit?: number
  netProfitList?: string  // Comma-separated PnL values
  winRate?: number
  maxBackRate?: number    // MDD in basis points
  orderNum?: number
  totalTraderAtom?: number
}

/**
 * Fetch equity curve for a BTCC trader.
 * Converts netProfitList (daily cumulative PnL) to EquityCurvePoint[].
 */
export async function fetchBtccEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  const trader = await findTraderInRanking(traderId)
  if (!trader?.netProfitList) return []

  const pnlValues = trader.netProfitList
    .split(',')
    .map(v => parseFloat(v.trim()))
    .filter(v => !isNaN(v))

  if (pnlValues.length < 2) return []

  return convertPnlListToEquityCurve(pnlValues, days, trader.totalTraderAtom)
}

/**
 * Fetch stats detail for a BTCC trader from ranking data.
 */
export async function fetchBtccStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const trader = await findTraderInRanking(traderId)
  if (!trader) return null

  const winRate = trader.winRate ?? null
  // maxBackRate in basis points → percentage, clamped to 0-100
  const maxDrawdown = trader.maxBackRate != null
    ? Math.min(Math.abs(trader.maxBackRate / 100), 100)
    : null

  return {
    totalTrades: trader.orderNum ?? null,
    profitableTradesPct: winRate,
    avgHoldingTimeHours: null,
    avgProfit: null,
    avgLoss: null,
    largestWin: null,
    largestLoss: null,
    sharpeRatio: (() => {
      if (!trader.netProfitList || typeof trader.netProfitList !== 'string') return null
      const values = trader.netProfitList.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v))
      if (values.length < 7) return null
      const returns = values.slice(1).map((v, i) => v - values[i])
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
      if (std <= 0) return null
      const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
      return sharpe > -20 && sharpe < 20 ? sharpe : null
    })(),
    maxDrawdown,
    currentDrawdown: null,
    volatility: null,
    copiersCount: trader.followNum ?? null,
    copiersPnl: null,
    aum: trader.totalTraderAtom != null && trader.totalTraderAtom > 0
      ? trader.totalTraderAtom
      : null,
    winningPositions: null,
    totalPositions: null,
  }
}

/**
 * Convert BTCC netProfitList (cumulative PnL in USDT) to EquityCurvePoint[].
 * We estimate ROI from PnL / totalTraderAtom (AUM proxy) if available.
 */
function convertPnlListToEquityCurve(
  pnlValues: number[],
  days: number,
  aum?: number
): EquityCurvePoint[] {
  const relevantData = pnlValues.slice(-days)
  if (relevantData.length === 0) return []

  const todayMs = Date.now()
  const points: EquityCurvePoint[] = []

  for (let i = 0; i < relevantData.length; i++) {
    const date = new Date(todayMs - (relevantData.length - 1 - i) * 86400000)

    // Estimate ROI from PnL / AUM; if no AUM, use PnL as relative metric
    const pnl = relevantData[i]
    let roi: number
    if (aum && aum > 0) {
      roi = (pnl / aum) * 100
    } else {
      roi = pnl // fallback: raw PnL as proxy
    }

    points.push({
      date: date.toISOString().split('T')[0],
      roi,
      pnl,
    })
  }

  return points
}

// Cache: traderId → BtccRankItem, refreshed per batch
const traderCache = new Map<string, BtccRankItem>()
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function findTraderInRanking(traderId: string): Promise<BtccRankItem | null> {
  if (traderCache.has(traderId) && Date.now() - cacheTimestamp < CACHE_TTL) {
    return traderCache.get(traderId) || null
  }

  await populateTraderCache()
  return traderCache.get(traderId) || null
}

async function populateTraderCache(): Promise<void> {
  if (Date.now() - cacheTimestamp < CACHE_TTL) return

  traderCache.clear()
  const maxPages = 20 // 1000 traders max (50/page)

  for (let page = 1; page <= maxPages; page++) {
    try {
      const data = await fetchJson<{
        code: number
        rows?: BtccRankItem[]
        data?: { rows?: BtccRankItem[]; list?: BtccRankItem[] }
      }>(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          pageNum: page,
          pageSize: 50,
          sortType: 4,
          nickName: '',
          flag: 'en-US',
        },
        timeoutMs: 10000,
      })

      const list = data?.rows || data?.data?.rows || data?.data?.list || []
      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list) {
        const id = String(item.traderId || '')
        if (id) traderCache.set(id, item)
      }

      if (list.length < 50) break
      await sleep(500)
    } catch (err) {
      logger.warn(`[btcc] Cache populate page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  cacheTimestamp = Date.now()
  logger.warn(`[btcc] Populated cache with ${traderCache.size} traders`)
}
