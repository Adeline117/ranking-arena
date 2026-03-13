/**
 * Weex — Inline fetcher for Vercel serverless
 *
 * Weex copy trading APIs require browser session cookies (x-sig, x-timestamp, etc.)
 * and the janapw.com gateway returns 521 without client-side generated headers.
 *
 * Strategy:
 * 1. Try direct API endpoints (may work from certain regions)
 * 2. VPS proxy fallback (route through SG/JP VPS)
 * 3. VPS Playwright scraper (browser-based bypass)
 *
 * Old import script used browser-real-chrome.mjs (Playwright) to navigate
 * weex.com/copy-trade and intercept the internal API calls.
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
} from '../shared'
import { type StatsDetail, upsertStatsDetail } from '../enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'weex'
const TARGET = 500
const PAGE_SIZE = 50
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

/** Weex period mapping */
const PERIOD_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': '90d',
}

const HEADERS: Record<string, string> = {
  Referer: 'https://www.weex.com/copy-trade',
  Origin: 'https://www.weex.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Multiple API endpoint patterns to try */
const API_ENDPOINTS = [
  // Internal web API patterns (discovered from browser interception)
  (page: number, period: string) =>
    `https://www.weex.com/api/v1/copy-trade/public/trader/rank?page=${page}&size=${PAGE_SIZE}&sort=roi&period=${period}`,
  (page: number, period: string) =>
    `https://www.weex.com/api/v1/copy-trade/leader/list?pageNo=${page}&pageSize=${PAGE_SIZE}&period=${period}&sortBy=roi`,
  (page: number, _period: string) =>
    `https://www.weex.com/api/v1/copy-trade/public/trader/rank?page=${page}&size=${PAGE_SIZE}&sort=roi`,
  // janapw.com gateway (WEEX internal backend)
  (page: number, period: string) =>
    `https://capi.janapw.com/api/v1/copy-trade/public/trader/rank?page=${page}&size=${PAGE_SIZE}&sort=roi&period=${period}`,
]

interface WeexTrader {
  traderId?: string
  traderUid?: string
  uid?: string
  userId?: string
  id?: string | number
  nickName?: string
  nickname?: string
  name?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  headUrl?: string
  userPhoto?: string
  // ROI fields
  yieldRate?: string | number
  roi?: string | number
  incomeRate?: string | number
  totalRoi?: string | number
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
  drawDown?: string | number
  mdd?: string | number
  // Followers
  followerCount?: number | string
  followers?: number | string
  copyCount?: number | string
  followNum?: number | string
  curr_follow_num?: number | string
  // Trades
  totalOrderNum?: number | string
  closedCount?: number | string
  tradeCount?: number | string
}

interface WeexResponse {
  code?: number | string
  msg?: string
  data?: {
    rows?: WeexTrader[]
    list?: WeexTrader[]
    records?: WeexTrader[]
    total?: number
  } | WeexTrader[]
  result?: {
    list?: WeexTrader[]
  }
}

function parseTrader(item: WeexTrader, period: string, rank: number): TraderData | null {
  const id = String(item.traderId || item.traderUid || item.uid || item.userId || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.yieldRate ?? item.roi ?? item.incomeRate ?? item.totalRoi)
  if (roi === null) return null
  // Normalize ROI: if small decimal, likely a ratio
  if (Math.abs(roi) > 0 && Math.abs(roi) < 20 && roi !== 0) roi *= 100

  const pnl = parseNum(item.totalProfit ?? item.profit ?? item.pnl ?? item.income)

  let winRate = parseNum(item.winRate ?? item.win_rate)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.maxDrawDown ?? item.maxDrawdown ?? item.drawDown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown < 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.followers ?? item.copyCount ?? item.followNum ?? item.curr_follow_num)
  const handle = item.nickName || item.nickname || item.name || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.weex.com/copy-trade/trader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar || item.avatarUrl || item.headUrl || item.userPhoto || null,
  }
}

function extractList(data: WeexResponse): WeexTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { rows?: WeexTrader[]; list?: WeexTrader[]; records?: WeexTrader[] }
    return d.list || d.rows || d.records || []
  }
  if (data.result?.list && Array.isArray(data.result.list)) return data.result.list
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30d'
  const allTraders = new Map<string, WeexTrader>()

  // Strategy 1: Direct API endpoints
  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, periodStr)
        const data = await fetchJson<WeexResponse>(url, { headers: HEADERS, timeoutMs: 15000 })
        const list = extractList(data)
        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        let newCount = 0
        for (const item of list) {
          const id = String(item.traderId || item.traderUid || item.uid || item.userId || item.id || '')
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
          const url = buildUrl(1, periodStr)
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
          const data = (await res.json()) as WeexResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.traderId || item.traderUid || item.uid || item.userId || item.id || '')
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
      const scraperUrl = `${VPS_SCRAPER_URL}/weex/leaderboard?pageSize=${PAGE_SIZE}&period=${periodStr}`
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const data = (await res.json()) as WeexResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.traderId || item.traderUid || item.uid || item.userId || item.id || '')
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
    return { total: 0, saved: 0, error: 'No data from Weex — all endpoints, VPS proxy, and VPS scraper failed' }
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

export async function fetchWeex(
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
