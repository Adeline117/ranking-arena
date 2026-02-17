/**
 * Crypto.com — Inline fetcher for Vercel serverless
 *
 * [STUB] NO PUBLIC API: Crypto.com's copy trading leaderboard at
 * https://crypto.com/exchange/copy-trading does not expose a public API.
 * The page is rendered client-side behind Cloudflare protection.
 * Internal API calls (e.g. /fe-ex-api/copy/...) require session cookies.
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

const SOURCE = 'cryptocom'
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': '90d',
}

const HEADERS: Record<string, string> = {
  Referer: 'https://crypto.com/exchange/copy-trading',
  Origin: 'https://crypto.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Known internal API patterns (require auth/session) */
const API_ENDPOINTS = [
  (page: number, period: string) =>
    `https://crypto.com/fe-ex-api/copy/leader/list?sort=roi&period=${period}&page=${page}&pageSize=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://crypto.com/exchange-api/copy-trading/leaders?sortBy=roi&period=${period}&page=${page}&limit=${PAGE_SIZE}`,
]

interface CryptoComTrader {
  leaderId?: string
  uid?: string
  id?: string | number
  nickname?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  roi?: number | string
  pnl?: number | string
  winRate?: number | string
  win_rate?: number | string
  maxDrawdown?: number | string
  max_drawdown?: number | string
  followers?: number | string
  followerCount?: number | string
  copiers?: number | string
}

interface CryptoComResponse {
  code?: number | string
  data?: {
    list?: CryptoComTrader[]
    rows?: CryptoComTrader[]
    total?: number
  } | CryptoComTrader[]
}

function parseTrader(item: CryptoComTrader, period: string, rank: number): TraderData | null {
  const id = String(item.leaderId || item.uid || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.pnl)
  let winRate = parseNum(item.winRate ?? item.win_rate)
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.max_drawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.followers ?? item.followerCount ?? item.copiers)
  const handle = item.nickname || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    avatar_url: item.avatar || item.avatarUrl || null,
    profile_url: `https://crypto.com/exchange/copy-trading/leader/${id}`,
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

function extractList(data: CryptoComResponse): CryptoComTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { list?: CryptoComTrader[]; rows?: CryptoComTrader[] }
    return d.list || d.rows || []
  }
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30d'
  const allTraders = new Map<string, CryptoComTrader>()

  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break
    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, periodStr)
        const data = await fetchJson<CryptoComResponse>(url, { headers: HEADERS, timeoutMs: 10000 })
        const list = extractList(data)

        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        for (const item of list) {
          const id = String(item.leaderId || item.uid || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(300)
      } catch {
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
    if (trader && trader.roi !== null && trader.roi !== 0) {
      traders.push(trader)
    }
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

export async function fetchCryptocom(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    result.periods[period] = await fetchPeriod(supabase, period)
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  result.duration = Date.now() - start
  return result
}
