/**
 * BTSE — Inline fetcher for Vercel serverless
 *
 * [STUB] NO PUBLIC LEADERBOARD API: BTSE's API (https://www.btse.com/apiexplorer/)
 * provides market data, trading, and wallet endpoints but does NOT have
 * copy-trading or leaderboard endpoints.
 *
 * BTSE does offer copy trading at https://www.btse.com/en/copy-trading but
 * the leaderboard data is loaded via internal APIs behind authentication.
 * No public endpoints found for ranking data.
 *
 * Checked:
 * - https://api.btse.com/futures/api/copy-trading (404)
 * - https://api.btse.com/spot/api/leaderboard (404)
 *
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
  parseNum,
  normalizeWinRate,
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'btse'
const TARGET = 500
const PAGE_SIZE = 50

const HEADERS: Record<string, string> = {
  Referer: 'https://www.btse.com/en/copy-trading',
  Origin: 'https://www.btse.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Speculative internal API endpoints */
const API_ENDPOINTS = [
  (page: number, period: string) =>
    `https://www.btse.com/api/copy-trading/leaders?sort=roi&period=${period}&page=${page}&size=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://api.btse.com/futures/api/v2/copy-trading/rank?sortBy=roi&period=${period}&offset=${(page - 1) * PAGE_SIZE}&limit=${PAGE_SIZE}`,
]

interface BtseTrader {
  leaderId?: string
  uid?: string
  id?: string | number
  nickname?: string
  displayName?: string
  avatar?: string
  roi?: number | string
  pnl?: number | string
  winRate?: number | string
  maxDrawdown?: number | string
  followers?: number | string
  copiers?: number | string
}

interface BtseResponse {
  code?: number | string
  data?: { list?: BtseTrader[]; rows?: BtseTrader[] } | BtseTrader[]
}

function parseTrader(item: BtseTrader, period: string, rank: number): TraderData | null {
  const id = String(item.leaderId || item.uid || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.pnl)
  const winRate = normalizeWinRate(parseNum(item.winRate))
  let maxDrawdown = parseNum(item.maxDrawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) maxDrawdown *= 100

  const followers = parseNum(item.followers ?? item.copiers)
  const handle = item.nickname || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    avatar_url: item.avatar || null,
    profile_url: `https://www.btse.com/en/copy-trading/leader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
  }
}

function extractList(data: BtseResponse): BtseTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { list?: BtseTrader[]; rows?: BtseTrader[] }
    return d.list || d.rows || []
  }
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, BtseTrader>()

  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break
    let consecutiveEmpty = 0

    for (let page = 1; page <= Math.ceil(TARGET / PAGE_SIZE); page++) {
      try {
        const url = buildUrl(page, period)
        const data = await fetchJson<BtseResponse>(url, { headers: HEADERS, timeoutMs: 10000 })
        const list = extractList(data)

        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        for (const item of list) {
          const id = String(item.leaderId || item.uid || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) allTraders.set(id, item)
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(300)
      } catch (err) {
        logger.warn(`[${SOURCE}] Page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
    if (allTraders.size > 0) break
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No public API available — needs browser scraping' }
  }

  const traders: TraderData[] = []
  let rank = 0
  for (const [, item] of Array.from(allTraders)) {
    rank++
    const trader = parseTrader(item, period, rank)
    if (trader && trader.roi !== null && trader.roi !== 0) traders.push(trader)
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

export async function fetchBtse(
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
        captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { platform: SOURCE, period },
        })
        logger.error(`[${SOURCE}] Period ${period} failed`, err instanceof Error ? err : new Error(String(err)))
        result.periods[period] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
      }
      if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
    }

    result.duration = Date.now() - start
    return result
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
    result.duration = Date.now() - start
    return result
  }
}
