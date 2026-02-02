/**
 * Aevo — Inline fetcher for Vercel serverless
 * API: https://api.aevo.xyz/leaderboard
 * Returns daily/weekly/monthly/all_time leaderboard data with PnL and volume
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared'

const SOURCE = 'aevo'
const API_URL = 'https://api.aevo.xyz/leaderboard'
const TARGET = 500

// Map our period names to Aevo API period keys
const PERIOD_MAP: Record<string, string> = {
  '7D': 'weekly',
  '30D': 'monthly',
  '90D': 'all_time',
}

// ── API response types ──

interface AevoLeaderboardEntry {
  ranking: number
  options_volume: number
  perp_volume: number
  pnl: number
  username: string
}

interface AevoLeaderboardResponse {
  leaderboard: Record<string, AevoLeaderboardEntry[]>
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string,
  leaderboard: Record<string, AevoLeaderboardEntry[]>
): Promise<{ total: number; saved: number; error?: string }> {
  const aevoPeriod = PERIOD_MAP[period]
  if (!aevoPeriod) {
    return { total: 0, saved: 0, error: `Unknown period ${period}` }
  }

  const entries = leaderboard[aevoPeriod]
  if (!entries || entries.length === 0) {
    return { total: 0, saved: 0, error: `No ${aevoPeriod} data from Aevo` }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const entry of entries) {
    if (!entry.username || entry.pnl === 0) continue

    const totalVolume = (entry.perp_volume || 0) + (entry.options_volume || 0)

    // Estimate ROI: Aevo doesn't provide capital, so approximate from volume
    // Use a conservative estimate: assume 10x avg leverage, so capital ≈ volume / 10
    // ROI = PnL / estimated_capital * 100
    const estimatedCapital = totalVolume > 0 ? totalVolume / 10 : 0
    const roi = estimatedCapital > 100
      ? (entry.pnl / estimatedCapital) * 100
      : entry.pnl > 0 ? 10 : -10 // fallback: small positive/negative

    // Clamp ROI to reasonable bounds
    const clampedRoi = Math.max(-100, Math.min(10000, roi))

    traders.push({
      source: SOURCE,
      source_trader_id: entry.username.toLowerCase(),
      handle: entry.username,
      profile_url: `https://app.aevo.xyz/portfolio/${entry.username}`,
      season_id: period,
      rank: entry.ranking,
      roi: clampedRoi,
      pnl: entry.pnl || null,
      win_rate: null, // Not provided by Aevo leaderboard API
      max_drawdown: null,
      trades_count: null,
      arena_score: calculateArenaScore(clampedRoi, entry.pnl, null, null, period),
      captured_at: capturedAt,
    })
  }

  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchAevo(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    // Fetch all leaderboard data in one call (API returns all periods)
    const data = await fetchJson<AevoLeaderboardResponse>(
      `${API_URL}?limit=${TARGET}`,
      { timeoutMs: 20000 }
    )

    const leaderboard = data?.leaderboard || {}

    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period, leaderboard)
      } catch (err) {
        result.periods[period] = {
          total: 0,
          saved: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  } catch (err) {
    // If the initial fetch fails, mark all periods as error
    for (const period of periods) {
      result.periods[period] = {
        total: 0,
        saved: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  result.duration = Date.now() - start
  return result
}
