/**
 * Phemex — Inline fetcher for Vercel serverless
 *
 * Working endpoint: phemex.com/api/phemex-user/users/children/queryTraderWithCopySetting
 * - Main site may return 403 from some regions (CloudFront geo-restriction)
 * - Falls back to VPS proxy and VPS Playwright scraper
 *
 * Old import script used browser-real-chrome.mjs (Playwright) to navigate
 * phemex.com/copy-trading and intercept the internal API calls.
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
  getWinRateFormat,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'phemex'
const TARGET = 500
const PAGE_SIZE = 50
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

/** Phemex period mapping (days) */
const PERIOD_MAP: Record<string, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

const HEADERS: Record<string, string> = {
  Referer: 'https://phemex.com/copy-trading',
  Origin: 'https://phemex.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Multiple API endpoint patterns to try — Dec 2025 migration may have changed paths */
const API_ENDPOINTS = [
  // New copy trading mode endpoint (Dec 2025 launch)
  (page: number, days: number) =>
    `https://phemex.com/api/phemex-user/copy-trading/v2/leaders?pageNo=${page}&pageSize=${PAGE_SIZE}&days=${days}&sortBy=roi&sortType=desc`,
  // Internal web API (discovered from browser interception)
  (page: number, days: number) =>
    `https://phemex.com/api/phemex-user/users/children/queryTraderWithCopySetting?pageNo=${page}&pageSize=${PAGE_SIZE}&days=${days}`,
  // Alternative endpoint
  (page: number, days: number) =>
    `https://phemex.com/api/phemex-user/users/children/queryTraderWithCopySetting?pageNo=${page}&pageSize=${PAGE_SIZE}&days=${days}&sortBy=roi&sortType=desc`,
  // api.phemex.com endpoint
  (page: number, days: number) =>
    `https://api.phemex.com/copy-trading/public/traders?page=${page}&pageSize=${PAGE_SIZE}&sortBy=roi&sortOrder=desc&period=${days}d`,
  // vapi.phemex.com (VIP endpoint, may work from some IPs)
  (page: number, days: number) =>
    `https://vapi.phemex.com/copy-trading/public/traders?page=${page}&pageSize=${PAGE_SIZE}&sortBy=roi&sortOrder=desc&period=${days}d`,
]

interface PhemexTrader {
  traderUid?: string
  userId?: string
  uid?: string
  id?: string | number
  nickName?: string
  nickname?: string
  name?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  userPhoto?: string
  portraitUrl?: string
  // ROI fields
  yieldRate?: string | number
  roi?: string | number
  totalRoi?: string | number
  copyTradeRoi?: string | number
  // PnL fields
  totalProfit?: string | number
  profit?: string | number
  pnl?: string | number
  income?: string | number
  // Stats
  winRate?: string | number
  win_rate?: string | number
  maxDrawDown?: string | number
  maxDrawdown?: string | number
  mdd?: string | number
  // Followers
  followerCount?: number | string
  followers?: number | string
  copyCount?: number | string
  followNum?: number | string
  // Trades
  totalOrderNum?: number | string
  closedCount?: number | string
  tradeCount?: number | string
}

interface PhemexResponse {
  code?: number | string
  msg?: string
  data?: {
    rows?: PhemexTrader[]
    list?: PhemexTrader[]
    total?: number
    totalCount?: number
  } | PhemexTrader[]
}

function parseTrader(item: PhemexTrader, period: string, rank: number): TraderData | null {
  const id = String(item.traderUid || item.userId || item.uid || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.yieldRate ?? item.roi ?? item.totalRoi ?? item.copyTradeRoi)
  if (roi === null) return null
  // Normalize ROI: if small decimal, likely a ratio (e.g., 0.25 = 25%)
  if (Math.abs(roi) > 0 && Math.abs(roi) < 20 && roi !== 0) roi *= 100

  const pnl = parseNum(item.totalProfit ?? item.profit ?? item.pnl ?? item.income)

  let winRate = parseNum(item.winRate ?? item.win_rate)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.maxDrawDown ?? item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown < 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.followers ?? item.copyCount ?? item.followNum)
  const handle = item.nickName || item.nickname || item.name || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://phemex.com/copy-trading/trader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar || item.avatarUrl || item.userPhoto || item.portraitUrl || null,
  }
}

function extractList(data: PhemexResponse): PhemexTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { rows?: PhemexTrader[]; list?: PhemexTrader[] }
    return d.rows || d.list || []
  }
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const days = PERIOD_MAP[period] || 30
  const allTraders = new Map<string, PhemexTrader>()

  // Strategy 1: Direct API endpoints
  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, days)
        const data = await fetchJson<PhemexResponse>(url, { headers: HEADERS, timeoutMs: 15000 })
        const list = extractList(data)
        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        let newCount = 0
        for (const item of list) {
          const id = String(item.traderUid || item.userId || item.uid || item.id || '')
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
      } catch (err) {
        logger.warn(`[${SOURCE}] Direct endpoint error: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }

    if (allTraders.size > 0) break
  }

  // Strategy 2: VPS proxy fallback
  if (allTraders.size === 0) {
    const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_SG
    if (vpsUrl) {
      logger.warn(`[${SOURCE}] Direct failed, trying VPS proxy...`)
      for (const buildUrl of API_ENDPOINTS) {
        if (allTraders.size >= TARGET) break
        try {
          const url = buildUrl(1, days)
          const res = await fetch(vpsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
            },
            body: JSON.stringify({ url, method: 'GET', headers: HEADERS }),
            signal: AbortSignal.timeout(30000),
          })
          if (!res.ok) continue
          const data = (await res.json()) as PhemexResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.traderUid || item.userId || item.uid || item.id || '')
            if (id && id !== 'undefined' && !allTraders.has(id)) {
              allTraders.set(id, item)
            }
          }
          if (allTraders.size > 0) {
            logger.warn(`[${SOURCE}] VPS proxy got ${allTraders.size} traders`)
            break
          }
        } catch (err) {
          logger.warn(`[${SOURCE}] VPS proxy failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  // Strategy 3: VPS Playwright scraper (browser-based bypass)
  if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
    logger.warn(`[${SOURCE}] Trying VPS Playwright scraper...`)
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/phemex/leaderboard?pageSize=${PAGE_SIZE}&days=${days}`
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const data = (await res.json()) as PhemexResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.traderUid || item.userId || item.uid || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
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
    return { total: 0, saved: 0, error: 'No data from Phemex — all endpoints, VPS proxy, and VPS scraper failed' }
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

  return { total: top.length, saved, error }
}

export async function fetchPhemex(
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
