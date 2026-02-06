/**
 * CoinEx — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_coinex.mjs (276 lines, puppeteer + DOM scraping)
 *
 * CoinEx copy trading page: https://www.coinex.com/en/copy-trading/futures
 *
 * ⚠️  BROWSER-ONLY: The original script uses pure DOM scraping (no API endpoint).
 * CoinEx perpetual API returns "unknown method" (code 4009) for all copy-trading paths.
 * The website internal API (www.coinex.com/res/) returns 404.
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
import { type StatsDetail, upsertStatsDetail } from './enrichment'

const SOURCE = 'coinex'
const TARGET = 500
const PAGE_SIZE = 50

const HEADERS: Record<string, string> = {
  Referer: 'https://www.coinex.com/en/copy-trading/futures',
  Origin: 'https://www.coinex.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/* ---------- response shapes ---------- */

interface CoinexTrader {
  // Various possible field names from CoinEx API
  trader_id?: string | number
  traderId?: string | number
  uid?: string | number
  id?: string | number
  nick_name?: string
  nickName?: string
  nickname?: string
  name?: string
  avatar?: string
  avatar_url?: string
  roi?: number | string
  roi_rate?: number | string
  return_rate?: number | string
  pnl?: number | string
  profit?: number | string
  total_pnl?: number | string
  win_rate?: number | string
  winRate?: number | string
  max_drawdown?: number | string
  maxDrawdown?: number | string
  mdd?: number | string
  follower_count?: number | string
  followerCount?: number | string
  copier_num?: number | string
}

interface CoinexApiResponse {
  code?: number
  message?: string
  data?: {
    list?: CoinexTrader[]
    items?: CoinexTrader[]
    traders?: CoinexTrader[]
    rows?: CoinexTrader[]
    total?: number
    page_count?: number
  } | CoinexTrader[]
}

/* ---------- parser ---------- */

function extractList(data: CoinexApiResponse): CoinexTrader[] {
  if (!data?.data) return []
  if (Array.isArray(data.data)) return data.data
  return data.data.list || data.data.items || data.data.traders || data.data.rows || []
}

function parseTrader(item: CoinexTrader, period: string): TraderData | null {
  const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
  if (!id) return null

  const nickname = item.nick_name || item.nickName || item.nickname || item.name || ''
  if (!nickname) return null

  let roi = parseNum(item.roi ?? item.roi_rate ?? item.return_rate)
  if (roi === null || roi === 0) return null
  // CoinEx may use decimal or percentage — normalize
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.pnl ?? item.profit ?? item.total_pnl)

  let winRate = parseNum(item.win_rate ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.max_drawdown ?? item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.follower_count ?? item.followerCount ?? item.copier_num)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: nickname,
    profile_url: `https://www.coinex.com/en/copy-trading/futures/trader/${id}`,
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

// CoinEx API endpoint candidates
const API_ENDPOINTS = [
  // Perpetual API — known to respond (even if currently "unknown method")
  (page: number) =>
    `https://api.coinex.com/perpetual/v1/market/copy_trading/trader?page=${page}&limit=${PAGE_SIZE}&sort_by=roi`,
  (page: number) =>
    `https://api.coinex.com/perpetual/v1/copy_trading/trader/list?page=${page}&limit=${PAGE_SIZE}`,
  (page: number) =>
    `https://api.coinex.com/perpetual/v1/copy_trading/ranking?page=${page}&limit=${PAGE_SIZE}`,
  // Website internal API
  (page: number) =>
    `https://www.coinex.com/res/copy-trading/futures/ranking?page=${page}&limit=${PAGE_SIZE}&sort_by=roi_rate`,
  (page: number) =>
    `https://www.coinex.com/res/copy/trader/list?page=${page}&limit=${PAGE_SIZE}`,
  // V2 API
  (page: number) =>
    `https://api.coinex.com/v2/futures/copy-trading/trader/ranking?page=${page}&limit=${PAGE_SIZE}`,
]

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, CoinexTrader>()
  let lastError = ''

  for (const makeUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    const maxPages = Math.ceil(TARGET / PAGE_SIZE)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = makeUrl(page)
        const data = await fetchJson<CoinexApiResponse>(url, { headers: HEADERS })

        // Skip "unknown method" responses (code 4009)
        if (data?.code === 4009) break

        const list = extractList(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
          if (id && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(500)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        break
      }
    }

    if (allTraders.size > 0) break
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data from CoinEx API (DOM-only platform)' }
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
        profitableTradesPct: trader.win_rate ?? null,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: trader.max_drawdown ?? null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: trader.followers ?? null,
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

export async function fetchCoinex(
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
