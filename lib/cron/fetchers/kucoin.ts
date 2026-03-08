/**
 * KuCoin — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_kucoin.mjs (285 lines, puppeteer + API interception)
 *
 * KuCoin copy trading page: https://www.kucoin.com/copytrading
 * The browser intercepts API responses containing 'leaderboard/query'.
 *
 * Working endpoints (from lib/connectors/kucoin.ts + platforms/kucoin-futures.ts):
 * 1. GET https://www.kucoin.com/_api/copy-trade/leader/rank-list (period=7/30/90)
 * 2. GET https://www.kucoin.com/_api/copy-trade/leader/public/list (period=SEVEN_DAY/THIRTY_DAY/NINETY_DAY)
 * Period config: Uses "days as lead" filter — 7D/30D/90D correspond to minimum days.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchWithFallback,
  sleep,
  parseNum,
  normalizeWinRate,
  normalizeROI,
  getWinRateFormat,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'kucoin'
const TARGET = 500
const PAGE_SIZE = 20
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

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
  leaderId?: string
  uid?: string
  nickName?: string
  avatarUrl?: string
  avatar?: string
  roi?: number | string          // from rank-list / public/list endpoints
  thirtyDayPnlRatio?: number     // from browser-intercepted API
  totalPnlRatio?: number
  daysAsLeader?: number
  winRatio?: number
  winRate?: number
  maxDrawdown?: number
  mdd?: number
  totalPnl?: number | string
  pnl?: number | string
  thirtyDayPnl?: number | string
  followerCount?: number
  copierCount?: number
  currentCopyCount?: number
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
  const id = String(item.leadConfigId || item.leaderId || item.uid || '')
  if (!id) return null

  // roi field from rank-list/public/list; thirtyDayPnlRatio from browser-intercepted API
  let roi = parseNum(item.roi ?? item.thirtyDayPnlRatio ?? item.totalPnlRatio)
  if (roi === null || roi === 0) return null
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.totalPnl ?? item.pnl ?? item.thirtyDayPnl ?? item.totalProfit)

  let winRate = parseNum(item.winRatio ?? item.winRate)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.copierCount ?? item.currentCopyCount)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: item.nickName || `KuCoin_${id.slice(0, 8)}`,
    profile_url: `https://www.kucoin.com/copy-trading/leader/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatarUrl || item.avatar || null,
  }
}

/* ---------- fetching ---------- */

/**
 * Working KuCoin API endpoints (from lib/connectors/kucoin.ts + platforms/kucoin-futures.ts):
 * 1. GET https://www.kucoin.com/_api/copy-trade/leader/rank-list
 *    Query: period=7/30/90, pageNo, pageSize, sortField=ROI
 * 2. GET https://www.kucoin.com/_api/copy-trade/leader/public/list
 *    Query: pageNo, pageSize, orderBy=ROI, period=SEVEN_DAY/THIRTY_DAY/NINETY_DAY
 * Both return: { code: "200000", data: { items: [...] } }
 */
const PERIOD_DAYS: Record<string, string> = { '7D': '7', '30D': '30', '90D': '90' }
const PERIOD_NAMES: Record<string, string> = { '7D': 'SEVEN_DAY', '30D': 'THIRTY_DAY', '90D': 'NINETY_DAY' }

const API_ENDPOINTS = [
  // Primary — legacy connector (rank-list)
  (page: number, period: string) =>
    `https://www.kucoin.com/_api/copy-trade/leader/rank-list?period=${PERIOD_DAYS[period] || '30'}&pageNo=${page}&pageSize=${PAGE_SIZE}&sortField=ROI`,
  // Fallback — platform connector (public/list)
  (page: number, period: string) =>
    `https://www.kucoin.com/_api/copy-trade/leader/public/list?pageNo=${page}&pageSize=${PAGE_SIZE}&orderBy=ROI&period=${PERIOD_NAMES[period] || 'THIRTY_DAY'}`,
]

async function fetchFromEndpoint(
  url: string,
  allTraders: Map<string, KucoinTrader>,
  minDays: number
): Promise<{ found: boolean; error?: string }> {
  try {
    const { data } = await fetchWithFallback<KucoinApiResponse>(url, { headers: HEADERS, platform: SOURCE })

    const items = data?.data?.items || data?.data?.list || []
    if (items.length === 0) return { found: false }

    for (const item of items) {
      const id = String(item.leadConfigId || item.leaderId || item.uid || '')
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
      const url = makeUrl(page, period)
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

  // VPS Playwright scraper fallback (browser-based bypass for CF challenge)
  if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
    logger.warn(`[${SOURCE}] All HTTP methods failed, trying VPS Playwright scraper...`)
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/kucoin/leaderboard?period=${PERIOD_DAYS[period] || '30'}&pageSize=${PAGE_SIZE}`
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const data = (await res.json()) as KucoinApiResponse
        const items = data?.data?.items || data?.data?.list || []
        for (const item of items) {
          const id = String(item.leadConfigId || item.leaderId || item.uid || '')
          if (id && !allTraders.has(id)) allTraders.set(id, item)
        }
        if (allTraders.size > 0) {
          logger.warn(`[${SOURCE}] VPS scraper got ${allTraders.size} traders`)
        }
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data from KuCoin — all endpoints and VPS scraper failed' }
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
    logger.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
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
    logger.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error: error || lastError || undefined }
}

export async function fetchKucoin(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      result.periods[period] = await fetchPeriod(supabase, period)
      if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
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
