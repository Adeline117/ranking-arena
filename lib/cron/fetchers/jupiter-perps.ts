/**
 * Jupiter Perpetuals (Solana) — Inline fetcher for Vercel serverless
 * API: https://perps-api.jup.ag (Jupiter Perps Stats API)
 *
 * Jupiter Perps does not currently expose a public leaderboard API.
 * This fetcher attempts multiple known and speculative endpoints:
 * 1. perps-api.jup.ag/v1/leaderboard
 * 2. stats.jup.ag/perps/leaderboard
 * 3. perps-api.jup.ag/v1/traders
 *
 * Until a public leaderboard endpoint is available, this fetcher
 * will report an error. The Jupiter team may add one in the future
 * as the protocol grows.
 *
 * Alternative approach: Jupiter perps data could be fetched via
 * Solana on-chain parsing or a custom indexer if needed.
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

const SOURCE = 'jupiter_perps'
const TARGET = 500

// Known and speculative Jupiter Perps API endpoints
const ENDPOINTS = [
  'https://perps-api.jup.ag/v1/leaderboard',
  'https://perps-api.jup.ag/v2/leaderboard',
  'https://stats.jup.ag/perps/leaderboard',
  'https://perps-api.jup.ag/v1/traders',
]

// ── API response types ──

interface JupiterTrader {
  wallet?: string
  address?: string
  owner?: string
  pnl?: number | string
  totalPnl?: number | string
  realized_pnl?: number | string
  roi?: number | string
  volume?: number | string
  totalVolume?: number | string
  winRate?: number | string
  win_rate?: number | string
  trades?: number
  positions?: number
  rank?: number
}

interface JupiterLeaderboardResponse {
  data?: JupiterTrader[]
  leaderboard?: JupiterTrader[]
  traders?: JupiterTrader[]
  result?: JupiterTrader[]
}

// ── Helpers ──

function toNum(v: string | number | undefined | null): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isNaN(n) ? 0 : n
}

// ── Try multiple endpoints ──

async function fetchTraderData(
  period: string
): Promise<{ traders: JupiterTrader[]; error?: string }> {
  for (const baseUrl of ENDPOINTS) {
    try {
      const url = `${baseUrl}?period=${period.toLowerCase()}&limit=${TARGET}`
      const data = await fetchJson<JupiterLeaderboardResponse>(url, {
        timeoutMs: 8000,
      })
      const traders =
        data?.data || data?.leaderboard || data?.traders || data?.result || []
      if (traders.length > 0) return { traders }
    } catch {
      // Try next endpoint
    }

    // Also try without query params
    try {
      const data = await fetchJson<JupiterLeaderboardResponse>(baseUrl, {
        timeoutMs: 8000,
      })
      const traders =
        data?.data || data?.leaderboard || data?.traders || data?.result || []
      if (traders.length > 0) return { traders }
    } catch {
      // Try next endpoint
    }
  }

  return {
    traders: [],
    error:
      'Jupiter Perps does not yet expose a public leaderboard API. ' +
      'Tried: ' +
      ENDPOINTS.join(', '),
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const { traders: rawTraders, error: fetchError } =
    await fetchTraderData(period)

  if (rawTraders.length === 0) {
    return { total: 0, saved: 0, error: fetchError || 'No data from Jupiter Perps' }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const entry of rawTraders) {
    const address = entry.wallet || entry.address || entry.owner || ''
    if (!address) continue

    const pnl = toNum(entry.pnl ?? entry.totalPnl ?? entry.realized_pnl)
    const volume = toNum(entry.volume ?? entry.totalVolume)
    const rawRoi = toNum(entry.roi)
    const winRate = toNum(entry.winRate ?? entry.win_rate) || null

    // Use provided ROI or estimate from PnL/volume
    let roi = rawRoi
    if (!roi && volume > 0) {
      const estimatedCapital = volume / 10 // assume ~10x leverage
      roi = estimatedCapital > 100 ? (pnl / estimatedCapital) * 100 : 0
    }

    const normalizedWinRate =
      winRate != null && winRate > 0 && winRate <= 1 ? winRate * 100 : winRate

    traders.push({
      source: SOURCE,
      source_trader_id: address.toLowerCase(),
      handle: `${address.slice(0, 4)}...${address.slice(-4)}`,
      profile_url: `https://app.jup.ag/perps/${address}`,
      season_id: period,
      rank: entry.rank || null,
      roi: Math.max(-100, Math.min(10000, roi)),
      pnl: pnl || null,
      win_rate: normalizedWinRate,
      max_drawdown: null,
      trades_count: entry.trades || entry.positions || null,
      arena_score: calculateArenaScore(roi, pnl, null, normalizedWinRate, period),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
  const top = traders.slice(0, TARGET)

  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchJupiterPerps(
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
