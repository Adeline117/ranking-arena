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
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

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

  // Attempt 0: VPS Playwright scraper (works without API key)
  const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
  const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''
  if (VPS_SCRAPER_KEY) {
    try {
      const res = await fetch(`${VPS_SCRAPER_URL}/drift/leaderboard?resolution=${resolution}&limit=${TARGET}`, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(120_000),
      })
      if (res.ok) {
        const data = (await res.json()) as DriftLeaderboardResponse
        const entries = data?.data || data?.leaderboard || data?.result || data?.users || []
        if (entries.length > 0) {
          logger.info(`[Drift] VPS scraper returned ${entries.length} entries`)
          return { entries }
        }
      }
    } catch (err) {
      logger.warn(`[Drift] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Check if API key is available for direct API calls
  if (!process.env.DRIFT_API_KEY) {
    return {
      entries: [],
      error:
        'Drift API requires authentication. Set DRIFT_API_KEY environment variable. ' +
        'VPS scraper also returned no data.',
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
    logger.warn(`[Drift] Main API failed: ${err instanceof Error ? err.message : String(err)}`)
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
    logger.warn(`[Drift] DLOB API failed: ${err instanceof Error ? err.message : String(err)}`)
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
    logger.warn(`[Drift] Users API failed: ${err instanceof Error ? err.message : String(err)}`)
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

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    logger.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
    let statsSaved = 0
    for (const trader of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: trader.trades_count ?? null,
        profitableTradesPct: trader.win_rate ?? null,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: trader.trades_count ?? null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    logger.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchDrift(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
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
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  result.duration = Date.now() - start
  return result
}
