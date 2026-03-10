/**
 * MEXC Enrichment
 *
 * MEXC copy-trading trader detail API provides per-trader stats.
 * Uses the VPS proxy for geo-blocked API access.
 *
 * Endpoint: futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid={id}
 */

import type { EquityCurvePoint, StatsDetail } from './enrichment-types'
import { fetchWithProxyFallback } from './enrichment-types'
import { logger } from '@/lib/logger'

const DETAIL_URL = 'https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail'

interface MexcTraderDetail {
  nickname?: string
  yield?: number
  pnl?: number
  winRate?: number
  maxRetrace?: number
  followerCount?: number
  copyCount?: number
  aum?: number
  profitDays?: number
  lossDays?: number
  totalDays?: number
  totalOrderNum?: number
  profitOrderNum?: number
  profitList?: Array<{ date: string; yield: number }>
}

/**
 * Fetch equity curve for a MEXC trader from the detail API.
 */
export async function fetchMexcEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  const detail = await fetchMexcDetail(traderId)
  if (!detail?.profitList || detail.profitList.length < 2) return []

  const relevantData = detail.profitList.slice(-days)
  return relevantData.map((p) => ({
    date: p.date,
    roi: (p.yield ?? 0) * 100,
    pnl: null,
  }))
}

/**
 * Fetch stats detail for a MEXC trader.
 */
export async function fetchMexcStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const detail = await fetchMexcDetail(traderId)
  if (!detail) return null

  const winRate = detail.winRate != null ? Number(detail.winRate) * 100 : null
  const maxDrawdown = detail.maxRetrace != null ? Number(detail.maxRetrace) * 100 : null
  const aum = detail.aum != null ? Number(detail.aum) : null

  return {
    totalTrades: detail.totalOrderNum ?? null,
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
    copiersCount: detail.followerCount ?? null,
    copiersPnl: null,
    aum: aum && aum > 0 ? aum : null,
    winningPositions: detail.profitOrderNum ?? null,
    totalPositions: detail.totalOrderNum ?? null,
  }
}

// Cache detail responses per batch run
const detailCache = new Map<string, MexcTraderDetail | null>()
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000

async function fetchMexcDetail(traderId: string): Promise<MexcTraderDetail | null> {
  if (detailCache.has(traderId) && Date.now() - cacheTimestamp < CACHE_TTL) {
    return detailCache.get(traderId) || null
  }

  try {
    const url = `${DETAIL_URL}?uid=${traderId}`
    const resp = await fetchWithProxyFallback<{ code?: number; data?: MexcTraderDetail }>(url, {
      timeoutMs: 10000,
    })

    if (resp?.code === 0 && resp.data) {
      detailCache.set(traderId, resp.data)
      cacheTimestamp = Date.now()
      return resp.data
    }

    detailCache.set(traderId, null)
    return null
  } catch (err) {
    logger.warn(`[mexc] Detail fetch failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    detailCache.set(traderId, null)
    return null
  }
}
