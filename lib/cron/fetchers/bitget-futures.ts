/**
 * Bitget Futures — Inline fetcher for Vercel serverless
 * API: https://api.bitget.com/api/v2/copy/mix-trader/trader-profit-ranking
 * Original: scripts/import/import_bitget_futures_v2.mjs (Puppeteer-based)
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

const SOURCE = 'bitget_futures'
const TARGET = 500
const PAGE_SIZE = 50

/** Bitget API period values */
const PERIOD_MAP: Record<string, string> = {
  '7D': 'SEVEN_DAYS',
  '30D': 'THIRTY_DAYS',
  '90D': 'NINETY_DAYS',
}

/** Bitget uses these base URLs — try multiple in case one is blocked */
const API_URLS = [
  'https://api.bitget.com/api/v2/copy/mix-trader/trader-profit-ranking',
  'https://api.bitget.com/api/v2/copy/mix-trader/query-trader-list',
]

const HEADERS: Record<string, string> = {
  Referer: 'https://www.bitget.com/',
  Origin: 'https://www.bitget.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

interface BitgetTrader {
  traderId?: string
  traderUid?: string
  uid?: string
  nickName?: string
  traderName?: string
  headUrl?: string
  avatar?: string
  profitRate?: string | number
  roi?: string | number
  yieldRate?: string | number
  totalProfit?: string | number
  profit?: string | number
  winRate?: string | number
  maxDrawdown?: string | number
  mdd?: string | number
  followerCount?: number
  copyTraderCount?: number
  currentCopiers?: number
  copyUserNum?: number
}

interface BitgetResponse {
  code?: string | number
  msg?: string
  data?: {
    traderList?: BitgetTrader[]
    list?: BitgetTrader[]
    total?: number
  }
}

function parseTrader(item: BitgetTrader, period: string, rank: number): TraderData | null {
  const id = item.traderId || item.traderUid || String(item.uid || '')
  if (!id) return null

  // ROI: Bitget may return as decimal (0.1234 = 12.34%) or percentage
  let roi = parseNum(item.profitRate ?? item.roi ?? item.yieldRate)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100 // decimal → percentage

  // PnL
  const pnl = parseNum(item.totalProfit ?? item.profit)

  // Win rate: decimal → percentage
  let winRate = parseNum(item.winRate)
  winRate = normalizeWinRate(winRate)

  // Max drawdown: decimal → percentage
  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  // Followers
  const followers = parseNum(item.followerCount ?? item.copyTraderCount ?? item.currentCopiers ?? item.copyUserNum)

  const handle = item.nickName || item.traderName || `Bitget_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.bitget.com/copy-trading/trader/${id}/futures`,
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

async function tryFetchTraders(
  apiUrl: string,
  period: string
): Promise<BitgetTrader[]> {
  const allTraders: BitgetTrader[] = []
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const periodParam = PERIOD_MAP[period] || period

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${apiUrl}?period=${periodParam}&pageNo=${page}&pageSize=${PAGE_SIZE}`
      const data = await fetchJson<BitgetResponse>(url, { headers: HEADERS })

      if (data.code !== '00000' && data.code !== 0 && data.code !== '0') {
        // Also try with the period as-is (7D, 30D, 90D)
        if (page === 1) {
          const altUrl = `${apiUrl}?period=${period}&pageNo=${page}&pageSize=${PAGE_SIZE}`
          const altData = await fetchJson<BitgetResponse>(altUrl, { headers: HEADERS })
          const altList = altData.data?.traderList || altData.data?.list || []
          if (altList.length > 0) {
            allTraders.push(...altList)
            continue
          }
        }
        break
      }

      const list = data.data?.traderList || data.data?.list || []
      if (list.length === 0) break

      allTraders.push(...list)
      if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
      await sleep(300)
    } catch {
      break
    }
  }

  return allTraders
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  let rawTraders: BitgetTrader[] = []

  // Try each API URL until one works
  for (const apiUrl of API_URLS) {
    try {
      rawTraders = await tryFetchTraders(apiUrl, period)
      if (rawTraders.length > 0) break
    } catch {
      continue
    }
  }

  if (rawTraders.length === 0) {
    return { total: 0, saved: 0, error: 'No data from any Bitget API endpoint' }
  }

  // Deduplicate by trader ID
  const seen = new Set<string>()
  const traders: TraderData[] = []
  let rank = 0

  for (const item of rawTraders) {
    const id = item.traderId || item.traderUid || String(item.uid || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
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

export async function fetchBitgetFutures(
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
