/**
 * Gate.io Enrichment
 *
 * Gate.io web API provides leader detail with profitList (daily returns).
 * Uses the same internal API as the leaderboard fetcher.
 *
 * Endpoints:
 * - Leader list: www.gate.com/apiw/v2/copy/leader/list (with profitList per trader)
 * - Leader detail: www.gate.com/apiw/v2/copy/leader/detail?leader_id={id}
 */

import type { EquityCurvePoint, StatsDetail, PortfolioPosition } from './enrichment-types'
import { fetchJson, sleep } from './shared'
import { logger } from '@/lib/logger'

const LIST_URL = 'https://www.gate.com/apiw/v2/copy/leader/list'
const DETAIL_URL = 'https://www.gate.com/apiw/v2/copy/leader/detail'

const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  Referer: 'https://www.gate.com/copy-trading',
  Origin: 'https://www.gate.com',
}

interface GateLeaderDetail {
  leader_id?: string | number
  nickname?: string
  profit_rate?: number
  profit?: number
  win_rate?: number
  mdd?: number
  copier_num?: number
  aum?: number | string
  trade_days?: number
  profit_list?: number[]
  total_order_num?: number
  win_order_num?: number
}

/**
 * Fetch equity curve for a Gate.io trader.
 */
export async function fetchGateioEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  const detail = await fetchTraderDetail(traderId)
  if (!detail?.profit_list || detail.profit_list.length < 2) return []

  return convertProfitListToEquityCurve(detail.profit_list, days)
}

/**
 * Fetch stats detail for a Gate.io trader.
 */
export async function fetchGateioStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  const detail = await fetchTraderDetail(traderId)
  if (!detail) return null

  const winRate = detail.win_rate != null ? Number(detail.win_rate) * 100 : null
  const maxDrawdown = detail.mdd != null ? Number(detail.mdd) * 100 : null
  const aum = detail.aum != null ? Number(detail.aum) : null

  return {
    totalTrades: detail.total_order_num ?? null,
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
    copiersCount: detail.copier_num ?? null,
    copiersPnl: null,
    aum: aum && aum > 0 ? aum : null,
    winningPositions: detail.win_order_num ?? null,
    totalPositions: detail.total_order_num ?? null,
  }
}

/**
 * Fetch current open positions for a Gate.io trader.
 * Public API, no auth needed.
 */
export async function fetchGateioCurrentPositions(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const url = `https://www.gate.io/apiw/v2/copy/leader/position?leader_id=${traderId}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return []
    const json = await resp.json()
    const positions = json?.data || []
    if (!Array.isArray(positions) || positions.length === 0) return []

    return positions.map((p: Record<string, unknown>) => ({
      symbol: String(p.market || 'UNKNOWN'),
      direction: String(p.side || 'long').toLowerCase() === 'short' ? 'short' as const : 'long' as const,
      investedPct: null,
      entryPrice: p.entry_price ? Number(p.entry_price) : null,
      pnl: p.unrealised_pnl ? Number(p.unrealised_pnl) : null,
    }))
  } catch (err) {
    logger.warn(`[gateio] Current positions failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

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
      roi: relevantData[i] * 100,
      pnl: null,
    })
  }

  return points
}

// Direct detail fetch — try dedicated detail endpoint first, fall back to list search
async function fetchTraderDetail(traderId: string): Promise<GateLeaderDetail | null> {
  // Strategy 1: Direct detail endpoint
  try {
    const url = `${DETAIL_URL}?leader_id=${traderId}`
    const resp = await fetchJson<{ data?: GateLeaderDetail }>(url, {
      headers: HEADERS,
      timeoutMs: 10000,
    })
    if (resp?.data?.leader_id) return resp.data
  } catch (err) {
    logger.warn(`[gateio] Detail endpoint failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Strategy 2: Search through ranking list
  return findTraderInRanking(traderId)
}

// Cache: traderId → detail, refreshed per batch
const traderCache = new Map<string, GateLeaderDetail>()
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000

async function findTraderInRanking(traderId: string): Promise<GateLeaderDetail | null> {
  if (traderCache.has(traderId) && Date.now() - cacheTimestamp < CACHE_TTL) {
    return traderCache.get(traderId) || null
  }

  await populateTraderCache()
  return traderCache.get(traderId) || null
}

async function populateTraderCache(): Promise<void> {
  if (Date.now() - cacheTimestamp < CACHE_TTL) return

  traderCache.clear()
  const maxPages = 10

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${LIST_URL}?page=${page}&page_size=50&order_by=profit_rate&sort_by=desc&cycle=month&status=running`
      const data = await fetchJson<{ data?: { list?: GateLeaderDetail[] } }>(url, {
        headers: HEADERS,
        timeoutMs: 10000,
      })

      const list = data?.data?.list
      if (!list || list.length === 0) break

      for (const item of list) {
        const id = String(item.leader_id || '')
        if (id) traderCache.set(id, item)
      }

      if (list.length < 50) break
      await sleep(500)
    } catch (err) {
      logger.warn(`[gateio] Cache populate page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  cacheTimestamp = Date.now()
  logger.warn(`[gateio] Populated cache with ${traderCache.size} traders`)
}
