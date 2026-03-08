/**
 * Paradex (Arbitrum) — Inline fetcher for Vercel serverless
 *
 * Paradex is a perpetual DEX on Arbitrum (built by Paradigm).
 * Uses the public REST API at api.prod.paradex.trade (no auth required).
 *
 * API: https://api.prod.paradex.trade/v1/leaderboard
 * Fields: account, pnl, roi, volume, win_rate, rank
 *
 * Period mapping:
 *   7D  → "WEEKLY"
 *   30D → "MONTHLY"
 *   90D → "ALL_TIME" (closest available)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  normalizeROI,
  normalizeWinRate,
  parseNum,
  sleep,
} from './shared'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'paradex'
const BASE_URL = 'https://api.prod.paradex.trade/v1'
const TARGET = 500
const PAGE_SIZE = 100

// Paradex API response types (best-guess based on common DEX patterns)
interface ParadexTraderEntry {
  account: string
  username?: string
  display_name?: string
  pnl?: number
  roi?: number
  volume?: number
  win_rate?: number
  total_trades?: number
  max_drawdown?: number
  rank?: number
  avatar_url?: string
}

interface ParadexLeaderboardResponse {
  results?: ParadexTraderEntry[]
  data?: ParadexTraderEntry[]
  next_cursor?: string
  count?: number
}

/** Map Arena period codes to Paradex API period strings */
function mapPeriod(period: string): string {
  switch (period) {
    case '7D':
      return 'WEEKLY'
    case '30D':
      return 'MONTHLY'
    case '90D':
      return 'ALL_TIME'
    default:
      return 'ALL_TIME'
  }
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allEntries: ParadexTraderEntry[] = []
  const paradexPeriod = mapPeriod(period)

  // Paginate through results
  let cursor: string | undefined
  for (let page = 0; page < Math.ceil(TARGET / PAGE_SIZE); page++) {
    let url = `${BASE_URL}/leaderboard?period=${paradexPeriod}&page_size=${PAGE_SIZE}`
    if (cursor) {
      url += `&cursor=${cursor}`
    } else if (page > 0) {
      url += `&offset=${page * PAGE_SIZE}`
    }

    try {
      const data = await fetchJson<ParadexLeaderboardResponse>(url, { timeoutMs: 15000 })

      // Handle both possible response shapes
      const entries = data?.results ?? data?.data ?? []
      if (!entries.length) break

      allEntries.push(...entries)
      cursor = data?.next_cursor ?? undefined

      if (entries.length < PAGE_SIZE) break
      if (!cursor && page > 0) break // No cursor-based pagination and already tried offset
    } catch (err) {
      if (page === 0) {
        return {
          total: 0,
          saved: 0,
          error: `Paradex API failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      break // Partial data is acceptable
    }

    if (page < Math.ceil(TARGET / PAGE_SIZE) - 1) await sleep(500)
  }

  if (allEntries.length === 0) {
    return { total: 0, saved: 0, error: 'Paradex API returned no data' }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const entry of allEntries) {
    if (!entry.account) continue

    const rawRoi = parseNum(entry.roi)
    // Paradex is a DEX — assume decimal format (0.5 = 50%) like most DEX APIs
    const roi = normalizeROI(rawRoi, 'decimal')
    const winRate = normalizeWinRate(parseNum(entry.win_rate), 'decimal')
    const pnl = parseNum(entry.pnl)
    const maxDrawdown = parseNum(entry.max_drawdown)

    const addr = entry.account
    const handle = entry.username || entry.display_name || `${addr.slice(0, 6)}...${addr.slice(-4)}`

    traders.push({
      source: SOURCE,
      source_trader_id: addr.toLowerCase(), // EVM addresses are case-insensitive
      handle,
      profile_url: `https://app.paradex.trade/portfolio/${addr}`,
      season_id: period,
      rank: entry.rank ?? null,
      roi: roi != null ? Math.max(-100, Math.min(10000, roi)) : null,
      pnl: pnl ?? null,
      win_rate: winRate ?? null,
      max_drawdown: maxDrawdown ?? null,
      followers: null,
      trades_count: parseNum(entry.total_trades) ?? null,
      arena_score: calculateArenaScore(roi ?? 0, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
      avatar_url: entry.avatar_url ?? null,
    })
  }

  // Take top N by PnL (already sorted by API, but enforce limit)
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  return { total: top.length, saved, error }
}

export async function fetchParadex(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period)
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { platform: SOURCE, period },
      })
      result.periods[period] = {
        total: 0,
        saved: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  result.duration = Date.now() - start
  return result
}
