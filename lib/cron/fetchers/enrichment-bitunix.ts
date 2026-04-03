/**
 * Bitunix Enrichment Module
 *
 * Uses the Bitunix copy-trading LIST API for trader stats and equity curve.
 * The individual /trader/detail endpoint returns only basic profile info (no ROI/winRate/mdd).
 * The /trader/positions and /trader/history endpoints return 404.
 *
 * Strategy: batch-fetch the leaderboard list once per enrichment run, cache it,
 * then look up individual traders from the cache. The list API returns:
 *   - roi, pl, mdd, winRate, winCount, aum, currentFollow
 *   - dailyWinRate[] (daily ROI equity curve)
 *   - symbolList[] (traded assets)
 *
 * Endpoints:
 * - POST https://api.bitunix.com/copy/trading/v1/trader/list  (leaderboard with stats + equity curve)
 * - POST https://api.bitunix.com/copy/trading/v1/trader/detail (basic profile only — aum, followers)
 */

import type { StatsDetail } from './enrichment-types'
import { logger } from '@/lib/logger'

const API_BASE = 'https://api.bitunix.com/copy/trading/v1'

interface BitunixListEntry {
  uid?: number | string
  nickname?: string
  header?: string | null
  roi?: string | number
  pl?: string | number
  mdd?: string | number
  winRate?: string | number
  winCount?: number
  currentFollow?: number
  aum?: string | number
  dailyWinRate?: Array<{ date: number | string; amount: string | number }>
  symbolList?: string[]
}

interface BitunixListResponse {
  code: number
  data?: {
    records?: BitunixListEntry[]
  }
}

const toNum = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return isNaN(n) ? null : n
}

// ============================================================
// Module-level cache: batch-fetched leaderboard data
// Keyed by period string (e.g., "7", "30", "90")
// Expires after 10 minutes to avoid stale data across runs
// ============================================================
interface CacheEntry {
  traders: Map<string, BitunixListEntry>
  fetchedAt: number
}

const leaderboardCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Fetch all pages of the Bitunix leaderboard and cache them.
 * Returns a Map of uid -> trader entry for O(1) lookups.
 */
async function ensureLeaderboardCached(period: string): Promise<Map<string, BitunixListEntry>> {
  const existing = leaderboardCache.get(period)
  if (existing && Date.now() - existing.fetchedAt < CACHE_TTL_MS) {
    return existing.traders
  }

  const traders = new Map<string, BitunixListEntry>()
  const maxPages = 10 // 100 per page × 10 = 1000 traders max
  const pageSize = 100

  for (let page = 1; page <= maxPages; page++) {
    try {
      const res = await fetch(`${API_BASE}/trader/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, pageNo: page, pageSize }),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        logger.warn(`[bitunix] List API page ${page} returned ${res.status}`)
        break
      }

      const json = (await res.json()) as BitunixListResponse
      const records = json?.data?.records || []

      if (records.length === 0) break

      for (const entry of records) {
        const uid = String(entry.uid || '')
        if (uid) traders.set(uid, entry)
      }

      if (records.length < pageSize) break // Last page
    } catch (err) {
      logger.warn(`[bitunix] List API page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  logger.info(`[bitunix] Cached ${traders.size} traders for period ${period}`)
  leaderboardCache.set(period, { traders, fetchedAt: Date.now() })
  return traders
}

/**
 * Map days param to Bitunix period string.
 * The list API uses "7", "30", "90" (not "7D", "30D", "90D").
 */
function daysToPeriod(days: number): string {
  if (days <= 7) return '7'
  if (days <= 30) return '30'
  return '90'
}

/**
 * Fetch stats detail from Bitunix leaderboard list API (cached batch lookup).
 */
export async function fetchBitunixStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Try 30D period first (most common), fall back to 7D then 90D
    for (const period of ['30', '7', '90']) {
      const cache = await ensureLeaderboardCached(period)
      const entry = cache.get(traderId)
      if (!entry) continue

      const winRate = toNum(entry.winRate)
      // winRate is in decimal format (0.65 = 65%)
      const profitableTradesPct = winRate != null ? winRate * 100 : null

      const mddRaw = toNum(entry.mdd)
      const maxDrawdown = mddRaw != null ? Math.abs(mddRaw * 100) : null

      // Derive totalTrades from winCount / winRate (both are real API data)
      const winCount = entry.winCount ?? null
      let totalTrades: number | null = null
      if (winCount != null && winCount > 0 && winRate != null && winRate > 0 && winRate <= 1) {
        totalTrades = Math.round(winCount / winRate)
      }

      // Compute Sharpe from dailyWinRate (daily cumulative ROI curve)
      let sharpeRatio: number | null = null
      const curve = entry.dailyWinRate
      if (Array.isArray(curve) && curve.length >= 3) {
        const values = curve.map(p => toNum(p.amount) ?? 0)
        const returns: number[] = []
        for (let i = 1; i < values.length; i++) returns.push(values[i] - values[i - 1])
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
        const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length)
        if (std > 0) {
          const raw = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
          sharpeRatio = Math.max(-20, Math.min(20, raw))
        }
      }

      return {
        totalTrades,
        profitableTradesPct: profitableTradesPct != null ? Math.round(profitableTradesPct * 10) / 10 : null,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio,
        maxDrawdown,
        currentDrawdown: null,
        volatility: null,
        copiersCount: toNum(entry.currentFollow),
        copiersPnl: null,
        aum: toNum(entry.aum),
        winningPositions: entry.winCount ?? null,
        totalPositions: null,
      }
    }

    return null
  } catch (err) {
    logger.warn(`[bitunix] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Build equity curve from Bitunix dailyWinRate (daily ROI data from list API).
 * dailyWinRate[].amount is cumulative ROI as ratio (0.812880 = 81.29%).
 */
export async function fetchBitunixEquityCurve(
  traderId: string,
  days: number
): Promise<Array<{ date: string; roi: number; pnl: number | null }>> {
  try {
    const period = daysToPeriod(days)
    const cache = await ensureLeaderboardCached(period)
    const entry = cache.get(traderId)

    if (!entry?.dailyWinRate || entry.dailyWinRate.length === 0) return []

    return entry.dailyWinRate.map((point) => {
      // date format: 20260312 (YYYYMMDD)
      const dateStr = String(point.date)
      const formatted = dateStr.length === 8
        ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
        : dateStr

      const roiRatio = toNum(point.amount)
      // Convert ratio to percentage (0.812880 → 81.29)
      const roiPct = roiRatio != null ? roiRatio * 100 : 0

      return {
        date: formatted,
        roi: roiPct,
        pnl: null, // List API doesn't provide daily PnL breakdown
      }
    })
  } catch (err) {
    logger.warn(`[bitunix] Equity curve failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Clear the leaderboard cache (useful for testing or forced refresh).
 */
export function clearBitunixCache(): void {
  leaderboardCache.clear()
}
