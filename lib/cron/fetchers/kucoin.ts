/**
 * KuCoin — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_kucoin.mjs (285 lines, puppeteer + API interception)
 *
 * KuCoin copy trading page: https://www.kucoin.com/copytrading
 * The browser intercepts API responses containing 'leaderboard/query'.
 *
 * ⚠️  BROWSER-ONLY: All known API endpoints return 404.
 * The original script uses Puppeteer to browse the page and intercept internal API calls.
 * The leaderboard/query endpoint is only accessible via browser context with session cookies.
 * Needs browser/proxy infrastructure to work.
 *
 * KuCoin API gateway: www.kucoin.com/_api/ (returns JSON 404 for all copy-trading paths)
 * Period config: Uses "days as lead" filter — 7D/30D/90D correspond to minimum days.
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
import { type StatsDetail, upsertStatsDetail } from './enrichment'

const SOURCE = 'kucoin'
const TARGET = 500
const PAGE_SIZE = 20

const HEADERS: Record<string, string> = {
  Referer: 'https://www.kucoin.com/copytrading',
  Origin: 'https://www.kucoin.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

const PERIOD_MIN_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

/* ---------- response shapes ---------- */

interface KucoinTrader {
  leadConfigId?: string
  nickName?: string
  avatarUrl?: string
  thirtyDayPnlRatio?: number
  totalPnlRatio?: number
  daysAsLeader?: number
  winRatio?: number
  winRate?: number
  maxDrawdown?: number
  mdd?: number
  totalPnl?: number | string
  thirtyDayPnl?: number | string
  followerCount?: number
  copierCount?: number
  totalProfit?: number | string
}

interface KucoinApiResponse {
  code?: string | number
  success?: boolean
  data?: {
    items?: KucoinTrader[]
    list?: KucoinTrader[]
    currentPage?: number
    totalPage?: number
    totalCount?: number
  }
}

/* ---------- parser ---------- */

function parseTrader(item: KucoinTrader, period: string): TraderData | null {
  const id = String(item.leadConfigId || '')
  if (!id) return null

  // thirtyDayPnlRatio is in decimal (e.g. 0.5 = 50%)
  let roi = parseNum(item.thirtyDayPnlRatio ?? item.totalPnlRatio)
  if (roi === null || roi === 0) return null
  if (Math.abs(roi) <= 10) roi *= 100

  const pnl = parseNum(item.totalPnl ?? item.thirtyDayPnl ?? item.totalProfit)

  let winRate = parseNum(item.winRatio ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.copierCount)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: item.nickName || `KuCoin_${id.slice(0, 8)}`,
    profile_url: `https://www.kucoin.com/copytrading/trader/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
  }
}

/* ---------- fetching ---------- */

// Multiple API endpoint candidates — KuCoin may use various gateway prefixes
const API_ENDPOINTS = [
  // KuCoin website gateway variants — the original script intercepted "leaderboard/query"
  (page: number) =>
    `https://www.kucoin.com/_api/copy-trading/leaderboard/query?pageNo=${page}&pageSize=${PAGE_SIZE}`,
  (page: number) =>
    `https://www.kucoin.com/_api/copytrading/leaderboard/query?pageNo=${page}&pageSize=${PAGE_SIZE}`,
  (page: number) =>
    `https://www.kucoin.com/_api/copy-trade/leaderboard/query?pageNo=${page}&pageSize=${PAGE_SIZE}`,
  // Public API variants
  (page: number) =>
    `https://api.kucoin.com/api/v1/copy-trading/leaderboard/query?pageNo=${page}&pageSize=${PAGE_SIZE}`,
  (page: number) =>
    `https://api-futures.kucoin.com/api/v1/copy-trading/leaderboard/query?pageNo=${page}&pageSize=${PAGE_SIZE}`,
]

async function fetchFromEndpoint(
  url: string,
  allTraders: Map<string, KucoinTrader>,
  minDays: number
): Promise<{ found: boolean; error?: string }> {
  try {
    const data = await fetchJson<KucoinApiResponse>(url, { headers: HEADERS })

    const items = data?.data?.items || data?.data?.list || []
    if (items.length === 0) return { found: false }

    for (const item of items) {
      const id = String(item.leadConfigId || '')
      if (!id || allTraders.has(id)) continue
      if (item.daysAsLeader != null && item.daysAsLeader < minDays) continue
      allTraders.set(id, item)
    }

    return { found: true }
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const minDays = PERIOD_MIN_DAYS[period] || 30
  const allTraders = new Map<string, KucoinTrader>()
  let lastError = ''

  // Try each API endpoint — stop at first one that returns data
  for (const makeUrl of API_ENDPOINTS) {
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      const url = makeUrl(page)
      const { found, error } = await fetchFromEndpoint(url, allTraders, minDays)

      if (error) {
        lastError = error
        break // this endpoint failed, try next
      }
      if (!found) break // no more pages

      if (allTraders.size >= TARGET) break
      await sleep(500)
    }

    if (allTraders.size > 0) break // found data from this endpoint
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data from KuCoin API (endpoint not found)' }
  }

  const traders: TraderData[] = []
  for (const [, item] of Array.from(allTraders)) {
    const t = parseTrader(item, period)
    if (t) traders.push(t)
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    console.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
    let statsSaved = 0
    for (const trader of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: null,
        profitableTradesPct: trader.win_rate,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: trader.max_drawdown,
        currentDrawdown: null,
        volatility: null,
        copiersCount: trader.followers,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    console.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error: error || lastError || undefined }
}

export async function fetchKucoin(
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
