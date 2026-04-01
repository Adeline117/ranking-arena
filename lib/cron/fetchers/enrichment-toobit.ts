/**
 * Toobit enrichment: stats detail from ranking API
 *
 * Toobit's API returns win_rate, max_drawdown, sharpe_ratio in its
 * ranking/identity-type-leaders responses. For enrichment, we fetch
 * the trader's detail from the ranking API.
 *
 * API: GET https://bapi.toobit.com/bapi/v1/copy-trading/ranking?page=1&dataType=90&kind=0
 * - Public, no auth required (but returns limited data per page)
 * - Also: identity-type-leaders endpoint
 *
 * Since there's no per-trader detail endpoint, we fetch rankings and cache them.
 * win_rate and max_drawdown are in ratio format (0-1).
 *
 * Equity curve: not available -> fallback to daily snapshots.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

// ============================================
// Cached rankings for batch lookup
// ============================================

interface ToobitTraderData {
  leaderUserId?: string
  leaderId?: string
  uid?: string
  leaderProfitOrderRatio?: number  // win rate (ratio 0-1)
  winRate?: number
  maxDrawdown?: number              // ratio 0-1
  sharpeRatio?: number
  profit?: number
  profitRatio?: number
  followerTotal?: number
  currentFollowerCount?: number
  totalOrderNum?: number            // total trades count
  tradeCount?: number               // alternative field name for trade count
  orderCount?: number               // alternative field name for trade count
  totalTradeNum?: number            // alternative field name for trade count
  profitOrderNum?: number           // winning trades count
  lossOrderNum?: number             // losing trades count
}

let cachedTraders: Map<string, ToobitTraderData> | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

async function ensureTraderCache(): Promise<Map<string, ToobitTraderData>> {
  if (cachedTraders && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedTraders
  }

  const map = new Map<string, ToobitTraderData>()

  // Fetch from ranking endpoint (all 5 kind values, multiple pages)
  for (const kind of [0, 1, 2, 3, 4]) {
    for (let page = 1; page <= 5; page++) {
      try {
        const data = await fetchJson<{ data?: { list?: ToobitTraderData[] } }>(
          `https://bapi.toobit.com/bapi/v1/copy-trading/ranking?page=${page}&dataType=90&kind=${kind}`,
          { timeoutMs: 10000 }
        )
        const list = data?.data?.list || []
        if (list.length === 0) break // No more pages
        for (const entry of list) {
          const id = entry.leaderUserId || entry.leaderId || entry.uid
          if (id && !map.has(id)) {
            map.set(id, entry)
          }
        }
      } catch {
        // Individual kind/page fetch failed, continue
        break
      }
    }
  }

  // Also fetch identity-type-leaders for additional data (all dataType periods)
  for (const dataType of [90, 30, 7]) {
    try {
      const data = await fetchJson<{ data?: Record<string, ToobitTraderData[]> }>(
        `https://bapi.toobit.com/bapi/v1/copy-trading/identity-type-leaders?dataType=${dataType}`,
        { timeoutMs: 10000 }
      )
      if (data?.data) {
        for (const entries of Object.values(data.data)) {
          if (!Array.isArray(entries)) continue
          for (const entry of entries) {
            const id = entry.leaderUserId || entry.leaderId || entry.uid
            if (id && !map.has(id)) {
              map.set(id, entry)
            }
          }
        }
      }
    } catch {
      // identity-type-leaders failed, continue with other periods
    }
  }

  cachedTraders = map
  cacheTimestamp = Date.now()
  return map
}

// ============================================
// Equity Curve
// ============================================

export async function fetchToobitEquityCurve(
  _traderId: string,
  _days: number = 90
): Promise<EquityCurvePoint[]> {
  return []
}

// ============================================
// Stats Detail
// ============================================

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

export async function fetchToobitStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const cache = await ensureTraderCache()
    const entry = cache.get(traderId)

    if (!entry) return null

    // winRate: ratio 0-1 → percentage
    const rawWr = safeNum(entry.leaderProfitOrderRatio ?? entry.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null

    // maxDrawdown: ratio 0-1 → absolute percentage
    const rawMdd = safeNum(entry.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    // Total trades: try multiple field names from the API
    const totalTrades = safeNum(entry.totalOrderNum ?? entry.tradeCount ?? entry.orderCount ?? entry.totalTradeNum)

    // Winning/losing positions from API
    const profitOrders = safeNum(entry.profitOrderNum)
    const lossOrders = safeNum(entry.lossOrderNum)

    // Derive totalTrades from profitOrderNum + lossOrderNum if direct field is null
    const derivedTotalTrades = totalTrades ?? (
      profitOrders != null && lossOrders != null ? profitOrders + lossOrders : null
    )

    // If we have winRate but no totalTrades, we can still write the winRate
    // If we have profitOrders/lossOrders, also compute winRate from those as fallback
    let finalWinRate = winRate
    if (finalWinRate == null && profitOrders != null && lossOrders != null) {
      const total = profitOrders + lossOrders
      if (total > 0) {
        finalWinRate = Math.round((profitOrders / total) * 10000) / 100
      }
    }

    return {
      totalTrades: derivedTotalTrades,
      profitableTradesPct: finalWinRate,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: safeNum(entry.sharpeRatio),
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: safeNum(entry.followerTotal ?? entry.currentFollowerCount),
      copiersPnl: null,
      aum: null,
      winningPositions: profitOrders,
      totalPositions: derivedTotalTrades,
    }
  } catch (err) {
    logger.warn(`[enrichment] Toobit stats detail failed for ${traderId}: ${err}`)
    return null
  }
}
