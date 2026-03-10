/**
 * Bitfinex — Inline fetcher for Vercel serverless
 *
 * Uses the public rankings API: GET /v2/rankings/{Key}:{TimeFrame}:{Symbol}/hist
 * Returns top 120 traders per key+timeframe combo.
 *
 * Keys: plu_diff (unrealized profit delta), plr (realized profit), plu (unrealized since inception), vol (volume)
 * TimeFrames: 3h, 1w, 1M
 * Response format: [mts, ?, username, rank, ?, ?, value, ?, status, ?, ?, ?, ?]
 *
 * ROI estimation: Bitfinex API provides only absolute PnL, no ROI%.
 * We fetch 'plu' (inception unrealized profit) as a proxy for account equity,
 * then estimate ROI = period_pnl / account_equity * 100.
 * Traders without equity data get PnL-only arena score (max 40/100).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  sleep,
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitfinex'
const API_BASE = 'https://api-pub.bitfinex.com/v2/rankings'

// Map Arena periods to Bitfinex timeframes
const PERIOD_MAP: Record<string, string> = {
  '7D': '1w',
  '30D': '1M',
  '90D': '1M', // Bitfinex only has 3h, 1w, 1M — use 1M for 90D
}

// Ranking keys for PnL data (period-specific)
const PNL_RANKING_KEYS = ['plu_diff', 'plr'] // unrealized profit delta, realized profit

interface BitfinexRankEntry {
  mts: number
  username: string
  rank: number
  value: number // PnL in USD
}

function parseRankings(data: unknown): BitfinexRankEntry[] {
  if (!Array.isArray(data)) return []
  return data
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 7)
    .map((row) => ({
      mts: row[0] as number,
      username: String(row[2] || ''),
      rank: Number(row[3]) || 0,
      value: Number(row[6]) || 0,
    }))
    .filter((e) => e.username && e.rank > 0)
}

/**
 * Fetch inception unrealized profit ('plu' key) as a proxy for account equity.
 * Returns a map of username → inception unrealized profit (USD).
 * This lets us estimate ROI = period_pnl / equity * 100.
 */
async function fetchAccountEquityProxy(): Promise<Map<string, number>> {
  const equityMap = new Map<string, number>()

  // Fetch plu (inception unrealized) at all available timeframes to maximize coverage
  // The value is the same regardless of timeframe since it's inception-based,
  // but different traders may appear at different timeframes
  for (const tf of ['1M', '1w']) {
    try {
      const url = `${API_BASE}/plu:${tf}:tGLOBAL:USD/hist`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) continue

      const data = await res.json()
      const entries = parseRankings(data)

      for (const entry of entries) {
        // Only use positive equity values (profitable accounts)
        if (entry.value > 0 && !equityMap.has(entry.username)) {
          equityMap.set(entry.username, entry.value)
        }
      }

      logger.info(`[${SOURCE}] plu:${tf} returned ${entries.length} traders for equity proxy (total: ${equityMap.size})`)
      await sleep(300)
    } catch {
      // Non-critical — we'll fall back to PnL-only scoring
    }
  }

  return equityMap
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string,
  equityMap: Map<string, number>
): Promise<{ total: number; saved: number; error?: string }> {
  const timeframe = PERIOD_MAP[period]
  if (!timeframe) {
    return { total: 0, saved: 0, error: `Unsupported period: ${period}` }
  }

  const allTraders = new Map<string, BitfinexRankEntry>()

  for (const key of PNL_RANKING_KEYS) {
    try {
      const url = `${API_BASE}/${key}:${timeframe}:tGLOBAL:USD/hist`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        logger.warn(`[${SOURCE}] ${key}:${timeframe} HTTP ${res.status}`)
        continue
      }

      const data = await res.json()
      const entries = parseRankings(data)

      for (const entry of entries) {
        if (!allTraders.has(entry.username)) {
          allTraders.set(entry.username, entry)
        }
      }

      logger.info(`[${SOURCE}] ${key}:${timeframe} returned ${entries.length} traders (total unique: ${allTraders.size})`)
      await sleep(300) // Rate limit courtesy
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`[${SOURCE}] ${key}:${timeframe} error: ${msg}`)
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from Bitfinex rankings API' }
  }

  let roiEstimated = 0
  let pnlOnly = 0
  const parsed: TraderData[] = []
  let rank = 0
  for (const [username, entry] of allTraders) {
    rank++
    const pnl = entry.value

    // Estimate ROI using inception unrealized profit as equity proxy
    // ROI = period_pnl / account_equity * 100
    let roi: number | null = null
    const equity = equityMap.get(username)
    if (equity && equity > 0 && pnl != null) {
      // Sanity check: cap estimated ROI at reasonable bounds
      // equity is inception unrealized profit, so this is an approximation
      const estimatedRoi = (pnl / equity) * 100
      // Only use estimate if it's within reasonable range (-500% to 10000%)
      if (estimatedRoi >= -500 && estimatedRoi <= 10000) {
        roi = Math.round(estimatedRoi * 100) / 100
        roiEstimated++
      }
    }

    if (roi == null) pnlOnly++

    // Compute arena score: use ROI if estimated, otherwise PnL-only (max 40)
    const arenaScore = roi != null
      ? calculateArenaScore(roi, pnl, null, null, period)
      : calculateArenaScore(0, pnl, null, null, period)

    parsed.push({
      source: SOURCE,
      source_trader_id: username,
      handle: username,
      profile_url: `https://leaderboard.bitfinex.com/`,
      season_id: period,
      rank: entry.rank || rank,
      roi,
      pnl,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      arena_score: arenaScore,
      captured_at: new Date().toISOString(),
    })
  }

  logger.info(`[${SOURCE}] ${period}: ${roiEstimated} ROI estimated, ${pnlOnly} PnL-only, ${parsed.length} total`)

  if (parsed.length > 0) {
    await upsertTraders(supabase, parsed)
  }

  return { total: allTraders.size, saved: parsed.length }
}

export async function fetchBitfinex(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  // Fetch equity proxy once (shared across all periods)
  const equityMap = await fetchAccountEquityProxy()
  logger.info(`[${SOURCE}] Equity proxy loaded for ${equityMap.size} traders`)

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period, equityMap)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      captureException(error, { tags: { platform: SOURCE, period } })
      logger.error(`[${SOURCE}] Period ${period} failed`, error)
      result.periods[period] = { total: 0, saved: 0, error: error.message }
    }
    if (periods.indexOf(period) < periods.length - 1) await sleep(500)
  }

  result.duration = Date.now() - start
  return result
}
