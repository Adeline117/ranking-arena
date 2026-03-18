/**
 * XT.com Enrichment Module
 *
 * Uses the XT.com internal copy-trading API for trader stats and equity curve.
 * The public /sapi/v1/copy-trading/leader/{id} endpoint returns 404.
 *
 * Strategy: batch-fetch the leaderboard list once per enrichment run, cache it,
 * then look up individual traders from the cache. The list API returns:
 *   - incomeRate (ROI ratio), income (PnL), maxRetraction (MDD ratio)
 *   - winRate (ratio), followerCount, chart[] (daily equity curve)
 *
 * Endpoint:
 * - GET https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2
 *   Returns grouped categories: INCOME_RATE, RECENT_MONTH_INCOME_RATE, STEADY, etc.
 *   Each category has items[] with trader data + chart equity curve.
 */

import type { StatsDetail } from './enrichment-types'
import { logger } from '@/lib/logger'

const API_BASE = 'https://www.xt.com/fapi/user/v1/public/copy-trade'

interface XtListEntry {
  accountId?: string
  nickName?: string
  avatar?: string
  days?: number
  income?: string | number
  incomeRate?: string | number
  winRate?: string | number
  maxRetraction?: number
  followerCount?: string | number
  followNumber?: number
  totalFollowerMargin?: string | number
  chart?: Array<{ amount: string | number; time: number }>
}

interface XtListResponse {
  returnCode: number
  result?: Array<{
    sotType?: string
    hasMore?: boolean
    items?: XtListEntry[]
  }>
}

const toNum = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return isNaN(n) ? null : n
}

// ============================================================
// Module-level cache: batch-fetched leaderboard data
// ============================================================
interface CacheEntry {
  traders: Map<string, XtListEntry>
  fetchedAt: number
}

const leaderboardCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://www.xt.com',
  'Referer': 'https://www.xt.com/en/copy-trading/futures',
}

/**
 * Fetch the XT leaderboard and cache all traders.
 * The API returns multiple categories; we merge all unique traders.
 * Returns a Map of accountId -> trader entry for O(1) lookups.
 */
async function ensureLeaderboardCached(days: number): Promise<Map<string, XtListEntry>> {
  const cacheKey = String(days)
  const existing = leaderboardCache.get(cacheKey)
  if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) {
    return existing.traders
  }

  const traders = new Map<string, XtListEntry>()

  // The XT API returns all categories in one call, each with up to ~20 items
  // Pagination requires pageNo parameter per category, but we'll fetch first few pages
  const maxPages = 5
  const pageSize = 50

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${API_BASE}/elite-leader-list-v2?pageNo=${page}&pageSize=${pageSize}&days=${days}`
      const res = await fetch(url, {
        method: 'GET',
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        logger.warn(`[xt] List API page ${page} returned ${res.status}`)
        break
      }

      const json = (await res.json()) as XtListResponse
      if (json.returnCode !== 0 || !json.result) break

      let newTraders = 0
      for (const group of json.result) {
        const items = group?.items || []
        for (const entry of items) {
          const id = String(entry.accountId || '')
          if (id && !traders.has(id)) {
            traders.set(id, entry)
            newTraders++
          }
        }
      }

      // If no new traders found on this page, stop
      if (newTraders === 0) break
    } catch (err) {
      logger.warn(`[xt] List API page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  logger.info(`[xt] Cached ${traders.size} traders for ${days}d period`)
  leaderboardCache.set(cacheKey, { traders, fetchedAt: Date.now() })
  return traders
}

/**
 * Map days param to XT API days value.
 */
function daysToPeriod(days: number): number {
  if (days <= 7) return 7
  if (days <= 30) return 30
  return 90
}

/**
 * Fetch stats detail from XT leaderboard list API (cached batch lookup).
 */
export async function fetchXtStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Try 30D period first, fall back to 7D then 90D
    for (const days of [30, 7, 90]) {
      const cache = await ensureLeaderboardCached(days)
      const entry = cache.get(traderId)
      if (!entry) continue

      const winRate = toNum(entry.winRate)
      // winRate is a ratio (0-1 scale)
      const profitableTradesPct = winRate != null ? winRate * 100 : null

      // maxRetraction is a ratio (0-1), always positive
      const mddRaw = toNum(entry.maxRetraction)
      const maxDrawdown = mddRaw != null ? Math.abs(mddRaw * 100) : null

      return {
        totalTrades: null,
        profitableTradesPct: profitableTradesPct != null ? Math.round(profitableTradesPct * 10) / 10 : null,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown,
        currentDrawdown: null,
        volatility: null,
        copiersCount: toNum(entry.followerCount),
        copiersPnl: null,
        aum: toNum(entry.totalFollowerMargin),
        winningPositions: null,
        totalPositions: null,
      }
    }

    return null
  } catch (err) {
    logger.warn(`[xt] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Build equity curve from XT chart data (daily ROI from list API).
 * chart[].amount is cumulative ROI as ratio (0.6929 = 69.29%).
 * chart[].time is Unix timestamp in milliseconds.
 */
export async function fetchXtEquityCurve(
  traderId: string,
  days: number
): Promise<Array<{ date: string; roi: number; pnl: number | null }>> {
  try {
    const period = daysToPeriod(days)
    const cache = await ensureLeaderboardCached(period)
    const entry = cache.get(traderId)

    if (!entry?.chart || entry.chart.length === 0) return []

    return entry.chart
      .filter((point) => point.time > 0) // Skip the initial {amount: "0", time: 0} sentinel
      .map((point) => {
        const date = new Date(point.time).toISOString().split('T')[0]
        const roiRatio = toNum(point.amount)
        // Convert ratio to percentage (0.6929 -> 69.29)
        const roiPct = roiRatio != null ? roiRatio * 100 : 0

        return {
          date,
          roi: roiPct,
          pnl: null, // Chart doesn't provide daily PnL breakdown
        }
      })
  } catch (err) {
    logger.warn(`[xt] Equity curve failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
