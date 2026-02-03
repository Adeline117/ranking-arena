/**
 * Drift Protocol (Solana) — Inline fetcher for Vercel serverless
 * 
 * STATUS: Requires API key
 * 
 * Drift is Solana's largest perps DEX. The leaderboard API requires authentication.
 * Set DRIFT_API_KEY environment variable to enable this fetcher.
 * 
 * API Base: https://mainnet-beta.api.drift.trade
 * 
 * Endpoints:
 * - /leaderboard?resolution=7d|30d|allTime - requires auth
 * - Public DLOB server at dlob.drift.trade - limited data
 * 
 * To get an API key:
 * 1. Contact Drift team or check developer docs
 * 2. Register for API access at drift.trade
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

const SOURCE = 'drift'
const API_BASE = 'https://mainnet-beta.api.drift.trade'
const DLOB_BASE = 'https://dlob.drift.trade'
const TARGET = 500

// Map our periods to Drift's resolution params
const RESOLUTION_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': 'allTime',
}

// ── API response types ──

interface DriftLeaderboardEntry {
  authority?: string
  userAccount?: string
  address?: string
  wallet?: string
  pnl?: number | string
  totalPnl?: number | string
  volume?: number | string
  totalVolume?: number | string
  winRate?: number | string
  win_rate?: number | string
  trades?: number
  tradeCount?: number
  rank?: number
}

interface DriftLeaderboardResponse {
  data?: DriftLeaderboardEntry[]
  leaderboard?: DriftLeaderboardEntry[]
  result?: DriftLeaderboardEntry[]
  users?: DriftLeaderboardEntry[]
}

// ── Helpers ──

function toNum(v: string | number | undefined | null): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? 0 : n
}

function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = process.env.DRIFT_API_KEY
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

// ── Try multiple endpoints ──

async function fetchLeaderboardData(
  period: string
): Promise<{ entries: DriftLeaderboardEntry[]; error?: string }> {
  const resolution = RESOLUTION_MAP[period] || 'allTime'
  const headers = getApiHeaders()

  // Check if API key is available
  if (!process.env.DRIFT_API_KEY) {
    return {
      entries: [],
      error:
        'Drift API requires authentication. Set DRIFT_API_KEY environment variable. ' +
        'Contact Drift team or check docs at drift.trade/developers for API access.',
    }
  }

  // Attempt 1: Direct leaderboard endpoint
  try {
    const data = await fetchJson<DriftLeaderboardResponse>(
      `${API_BASE}/leaderboard?resolution=${resolution}&offset=0&limit=${TARGET}`,
      { headers, timeoutMs: 15000 }
    )
    const entries =
      data?.data || data?.leaderboard || data?.result || data?.users || []
    if (entries.length > 0) return { entries }
  } catch (err) {
    // Continue to next attempt
    console.warn('[Drift] Main API failed:', err)
  }

  // Attempt 2: DLOB server leaderboard
  try {
    const data = await fetchJson<DriftLeaderboardResponse>(
      `${DLOB_BASE}/leaderboard?resolution=${resolution}&limit=${TARGET}`,
      { headers, timeoutMs: 15000 }
    )
    const entries =
      data?.data || data?.leaderboard || data?.result || data?.users || []
    if (entries.length > 0) return { entries }
  } catch (err) {
    console.warn('[Drift] DLOB API failed:', err)
  }

  // Attempt 3: Users endpoint with PnL sorting
  try {
    const data = await fetchJson<DriftLeaderboardResponse>(
      `${API_BASE}/users?sortBy=pnl&order=desc&limit=${TARGET}`,
      { headers, timeoutMs: 15000 }
    )
    const entries =
      data?.data || data?.leaderboard || data?.result || data?.users || []
    if (entries.length > 0) return { entries }
  } catch (err) {
    console.warn('[Drift] Users API failed:', err)
  }

  return {
    entries: [],
    error: 'Drift API returned no data. Check API key validity or try again later.',
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const { entries, error: fetchError } = await fetchLeaderboardData(period)

  if (entries.length === 0) {
    return { total: 0, saved: 0, error: fetchError || 'No data from Drift API' }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const entry of entries) {
    const address =
      entry.authority || entry.userAccount || entry.address || entry.wallet || ''
    if (!address) continue

    const pnl = toNum(entry.pnl ?? entry.totalPnl)
    const volume = toNum(entry.volume ?? entry.totalVolume)
    const winRate = toNum(entry.winRate ?? entry.win_rate) || null
    const tradesCount = entry.trades || entry.tradeCount || null

    // Estimate ROI from PnL and volume (assume ~10x avg leverage)
    const estimatedCapital = volume > 0 ? volume / 10 : 0
    const roi =
      estimatedCapital > 100 ? (pnl / estimatedCapital) * 100 : pnl > 0 ? 5 : -5

    // Normalize win rate if it's 0-1 range
    const normalizedWinRate =
      winRate != null && winRate > 0 && winRate <= 1 ? winRate * 100 : winRate

    traders.push({
      source: SOURCE,
      source_trader_id: address.toLowerCase(),
      handle: `${address.slice(0, 4)}...${address.slice(-4)}`,
      profile_url: `https://app.drift.trade/overview?userAccount=${address}`,
      season_id: period,
      rank: entry.rank || null,
      roi: Math.max(-100, Math.min(10000, roi)),
      pnl: pnl || null,
      win_rate: normalizedWinRate,
      max_drawdown: null,
      trades_count: tradesCount,
      arena_score: calculateArenaScore(roi, pnl, null, normalizedWinRate, period),
      captured_at: capturedAt,
    })
  }

  // Sort by PnL (since ROI is estimated)
  traders.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
  const top = traders.slice(0, TARGET)

  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchDrift(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period)
    } catch (err) {
      result.periods[period] = {
        total: 0,
        saved: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (periods.indexOf(period) < periods.length - 1) await sleep(2000)
  }

  result.duration = Date.now() - start
  return result
}
