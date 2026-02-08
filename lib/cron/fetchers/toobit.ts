/**
 * Toobit — Inline fetcher for Vercel serverless
 *
 * Toobit copy trading page: https://www.toobit.com/en-US/copy-trading
 * API endpoint discovered: https://www.toobit.com/api/v1/copy/leader/rank
 *
 * The copy trading leaderboard may be accessible via their internal API.
 * Toobit is a smaller exchange — endpoints may require session auth.
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

const SOURCE = 'toobit'
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_MAP: Record<string, string> = {
  '7D': '7',
  '30D': '30',
  '90D': '90',
}

const HEADERS: Record<string, string> = {
  Referer: 'https://www.toobit.com/en-US/copy-trading',
  Origin: 'https://www.toobit.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

const API_ENDPOINTS = [
  (page: number, period: string) =>
    `https://www.toobit.com/api/v1/copy/leader/rank?sortBy=roi&period=${period}&page=${page}&pageSize=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://www.toobit.com/api/v1/copy-trading/leaders?sort=roi&days=${period}&page=${page}&limit=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://api.toobit.com/api/v1/copy/leader/list?sortBy=roi&period=${period}&page=${page}&pageSize=${PAGE_SIZE}`,
]

interface ToobitTrader {
  leaderId?: string
  uid?: string
  userId?: string
  id?: string | number
  nickname?: string
  nickName?: string
  displayName?: string
  name?: string
  avatar?: string
  avatarUrl?: string
  roi?: number | string
  returnRate?: number | string
  pnl?: number | string
  profit?: number | string
  winRate?: number | string
  win_rate?: number | string
  maxDrawdown?: number | string
  max_drawdown?: number | string
  followers?: number | string
  followerCount?: number | string
  copiers?: number | string
  copyCount?: number | string
}

interface ToobitResponse {
  code?: number | string
  data?: {
    list?: ToobitTrader[]
    rows?: ToobitTrader[]
    records?: ToobitTrader[]
    total?: number
  } | ToobitTrader[]
  msg?: string
}

function parseTrader(item: ToobitTrader, period: string, rank: number): TraderData | null {
  const id = String(item.leaderId || item.uid || item.userId || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.returnRate)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.pnl ?? item.profit)
  let winRate = normalizeWinRate(parseNum(item.winRate ?? item.win_rate))
  let maxDrawdown = parseNum(item.maxDrawdown ?? item.max_drawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) maxDrawdown *= 100

  const followers = parseNum(item.followers ?? item.followerCount ?? item.copiers ?? item.copyCount)
  const handle = item.nickname || item.nickName || item.displayName || item.name || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    avatar_url: item.avatar || item.avatarUrl || null,
    profile_url: `https://www.toobit.com/en-US/copy-trading/leader/${id}`,
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

function extractList(data: ToobitResponse): ToobitTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { list?: ToobitTrader[]; rows?: ToobitTrader[]; records?: ToobitTrader[] }
    return d.list || d.rows || d.records || []
  }
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30'
  const allTraders = new Map<string, ToobitTrader>()

  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break
    let consecutiveEmpty = 0

    for (let page = 1; page <= Math.ceil(TARGET / PAGE_SIZE); page++) {
      try {
        const url = buildUrl(page, periodStr)
        const data = await fetchJson<ToobitResponse>(url, { headers: HEADERS, timeoutMs: 10000 })
        const list = extractList(data)

        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        for (const item of list) {
          const id = String(item.leaderId || item.uid || item.userId || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) allTraders.set(id, item)
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
    return { total: 0, saved: 0, error: 'No data from Toobit API endpoints — may need browser scraping' }
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

export async function fetchToobit(
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
