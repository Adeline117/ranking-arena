/**
 * LBank — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_lbank.mjs (Puppeteer-based with Stealth plugin)
 *
 * ⚠️  NO PUBLIC API: LBank doesn't have documented public APIs for copy trading.
 * The website returns generic HTML pages for all API paths tested.
 * Original script uses Puppeteer to browse and intercept internal API calls.
 * Needs browser/proxy infrastructure to work.
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

const SOURCE = 'lbank'
const TARGET = 500
const PAGE_SIZE = 50

/** LBank period mapping */
const PERIOD_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': '90d',
}

const HEADERS: Record<string, string> = {
  Referer: 'https://www.lbank.com/copy-trading',
  Origin: 'https://www.lbank.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Multiple API endpoint patterns to try */
const API_ENDPOINTS = [
  // Common internal API patterns for LBank
  (page: number, period: string) =>
    `https://www.lbank.com/api/copy-trading/trader/ranking?period=${period}&page=${page}&size=${PAGE_SIZE}&sort=roi`,
  (page: number, period: string) =>
    `https://www.lbank.com/api/v1/copy/trader/list?period=${period}&pageNo=${page}&pageSize=${PAGE_SIZE}&sortBy=roi`,
  (page: number, period: string) =>
    `https://www.lbank.com/api/copy_trading/leaders?period=${period}&page=${page}&limit=${PAGE_SIZE}`,
  (page: number, _period: string) =>
    `https://www.lbank.com/api/v2/copy/trader/ranking?page=${page}&size=${PAGE_SIZE}`,
  (page: number, _period: string) =>
    `https://www.lbank.com/en-US/api/copy-trading/list?page=${page}&limit=${PAGE_SIZE}&sort=roi`,
]

interface LbankTrader {
  uid?: string
  userId?: string
  traderId?: string
  id?: string | number
  memberId?: string
  nickname?: string
  nickName?: string
  name?: string
  userName?: string
  avatar?: string
  headUrl?: string
  avatarUrl?: string
  photo?: string
  roi?: string | number
  returnRate?: string | number
  profitRate?: string | number
  yield?: string | number
  pnl?: string | number
  profit?: string | number
  totalProfit?: string | number
  totalPnl?: string | number
  winRate?: string | number
  winRatio?: string | number
  maxDrawdown?: string | number
  mdd?: string | number
  followerCount?: number | string
  followers?: number | string
  copyCount?: number | string
  followNum?: number | string
}

interface LbankResponse {
  code?: number | string
  data?: {
    list?: LbankTrader[]
    traders?: LbankTrader[]
    total?: number
  } | LbankTrader[]
  result?: {
    list?: LbankTrader[]
  }
  rows?: LbankTrader[]
  msg?: string
}

function parseTrader(item: LbankTrader, period: string, rank: number): TraderData | null {
  const id = String(item.uid || item.userId || item.traderId || item.id || item.memberId || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.returnRate ?? item.profitRate ?? item.yield)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

  const pnl = parseNum(item.pnl ?? item.profit ?? item.totalProfit ?? item.totalPnl)

  let winRate = parseNum(item.winRate ?? item.winRatio)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.followers ?? item.copyCount ?? item.followNum)
  const handle = item.nickname || item.nickName || item.name || item.userName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.lbank.com/copy-trading/trader/${id}`,
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

function extractList(data: LbankResponse): LbankTrader[] {
  if (!data) return []

  // Direct array
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data

  // Nested data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { list?: LbankTrader[]; traders?: LbankTrader[] }
    if (d.list && Array.isArray(d.list)) return d.list
    if (d.traders && Array.isArray(d.traders)) return d.traders
  }

  // result.list pattern
  if (data.result?.list && Array.isArray(data.result.list)) return data.result.list

  // rows pattern
  if (data.rows && Array.isArray(data.rows)) return data.rows

  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30d'
  const allTraders = new Map<string, LbankTrader>()

  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, periodStr)
        const data = await fetchJson<LbankResponse>(url, { headers: HEADERS, timeoutMs: 10000 })

        const list = extractList(data)
        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        let newCount = 0
        for (const item of list) {
          const id = String(item.uid || item.userId || item.traderId || item.id || item.memberId || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) {
            allTraders.set(id, item)
            newCount++
          }
        }

        if (newCount === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
        } else {
          consecutiveEmpty = 0
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
    return { total: 0, saved: 0, error: 'No data from LBank API endpoints (likely CF-protected)' }
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

export async function fetchLbank(
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
