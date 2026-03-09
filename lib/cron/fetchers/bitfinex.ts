/**
 * Bitfinex — Inline fetcher for Vercel serverless
 *
 * Uses the public rankings API: GET /v2/rankings/{Key}:{TimeFrame}:{Symbol}/hist
 * Returns top 120 traders per key+timeframe combo.
 *
 * Keys: plu_diff (unrealized profit delta), plr (realized profit), vol (volume)
 * TimeFrames: 3h, 1w, 1M
 * Response format: [mts, ?, username, rank, ?, ?, value, ?, ?, ?, ?, ?, ?]
 *
 * Note: No per-trader detail API exists — enrichment is NOT possible.
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

// Multiple ranking keys to get broader coverage
const RANKING_KEYS = ['plu_diff', 'plr'] // unrealized profit delta, realized profit

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

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const timeframe = PERIOD_MAP[period]
  if (!timeframe) {
    return { total: 0, saved: 0, error: `Unsupported period: ${period}` }
  }

  const allTraders = new Map<string, BitfinexRankEntry>()

  for (const key of RANKING_KEYS) {
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

  const parsed: TraderData[] = []
  let rank = 0
  for (const [username, entry] of allTraders) {
    rank++
    const pnl = entry.value
    // Bitfinex doesn't provide ROI directly — estimate from PnL relative to median
    const roi = null

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
      arena_score: roi != null ? calculateArenaScore(roi, pnl, null, null, period) : null,
      captured_at: new Date().toISOString(),
    })
  }

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

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period)
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
