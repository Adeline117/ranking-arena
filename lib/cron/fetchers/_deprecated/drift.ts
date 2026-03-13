/**
 * Drift Protocol (Solana) — Inline fetcher for Vercel serverless
 *
 * Uses the public data API at data.api.drift.trade (no auth required).
 * Fetches PnL-ranked leaderboard with pagination.
 *
 * API: https://data.api.drift.trade/stats/leaderboard?page=1&limit=100&sort=pnl
 * Fields: authority (wallet), volume, pnl, rank
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from '../shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'drift'
const DATA_API = 'https://data.api.drift.trade'
const TARGET = 500
const PAGE_SIZE = 100

interface DriftEntry {
  authority: string
  volume: number
  pnl: number
  rank: number
}

interface DriftResponse {
  success: boolean
  data: {
    leaderboard: DriftEntry[]
  }
}

function getDateRange(period: string): { start: string; end: string } | null {
  const now = new Date()
  const end = now.toISOString().split('T')[0]
  const ms = now.getTime()
  switch (period) {
    case '7D': return { start: new Date(ms - 7 * 86400000).toISOString().split('T')[0], end }
    case '30D': return { start: new Date(ms - 30 * 86400000).toISOString().split('T')[0], end }
    case '90D': return null // allTime
    default: return null
  }
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allEntries: DriftEntry[] = []
  const dateRange = getDateRange(period)

  // Paginate through results
  for (let page = 1; page <= Math.ceil(TARGET / PAGE_SIZE); page++) {
    let url = `${DATA_API}/stats/leaderboard?page=${page}&limit=${PAGE_SIZE}&sort=pnl`
    if (dateRange) {
      url += `&start=${dateRange.start}&end=${dateRange.end}`
    }

    try {
      const data = await fetchJson<DriftResponse>(url, { timeoutMs: 15000 })
      if (!data?.success || !data.data?.leaderboard?.length) break
      allEntries.push(...data.data.leaderboard)
      if (data.data.leaderboard.length < PAGE_SIZE) break
    } catch (err) {
      if (page === 1) {
        return { total: 0, saved: 0, error: `Drift API failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      break // Partial data is fine
    }

    if (page < Math.ceil(TARGET / PAGE_SIZE)) await sleep(500)
  }

  if (allEntries.length === 0) {
    return { total: 0, saved: 0, error: 'Drift data API returned no data' }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const entry of allEntries) {
    if (!entry.authority) continue

    // Estimate ROI from PnL and volume (assume ~10x avg leverage)
    const estimatedCapital = entry.volume > 0 ? entry.volume / 10 : 0
    const roi = estimatedCapital > 100
      ? (entry.pnl / estimatedCapital) * 100
      : entry.pnl > 0 ? 5 : -5

    const addr = entry.authority
    traders.push({
      source: SOURCE,
      source_trader_id: addr, // Solana addresses are case-sensitive (base58)
      handle: `${addr.slice(0, 4)}...${addr.slice(-4)}`,
      profile_url: `https://app.drift.trade/overview?userAccount=${addr}`,
      season_id: period,
      rank: entry.rank || null,
      roi: Math.max(-100, Math.min(10000, roi)),
      pnl: entry.pnl || null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      arena_score: calculateArenaScore(roi, entry.pnl, null, null, period),
      captured_at: capturedAt,
      avatar_url: null,
    })
  }

  // Already sorted by PnL from API
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  return { total: top.length, saved, error }
}

export async function fetchDrift(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  // Hard timeout protection: 5 minutes max
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout: fetchDrift exceeded 5 minutes')), 300000)
  )

  const mainWork = async (): Promise<FetchResult> => {
    const start = Date.now()
    const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period)
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { platform: SOURCE, period },
        })
        result.periods[period] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
      }
      if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
    }

    result.duration = Date.now() - start
    return result
  }

  return Promise.race([mainWork(), timeoutPromise])
}
