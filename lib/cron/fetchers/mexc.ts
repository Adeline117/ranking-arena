/**
 * MEXC Futures — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_mexc.mjs (589 lines, puppeteer + API interception)
 *
 * MEXC copy trading page: https://www.mexc.com/futures/copyTrade/home
 *
 * Working endpoints (from lib/connectors/mexc.ts + platforms/mexc-futures.ts):
 * 1. POST https://www.mexc.com/api/platform/copy-trade/rank/list (periodType: 1=7d, 2=30d, 3=90d)
 * 2. GET https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list
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
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'mexc'
const TARGET = 500
const PAGE_SIZE = 50
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

const HEADERS: Record<string, string> = {
  Referer: 'https://www.mexc.com/futures/copyTrade/home',
  Origin: 'https://www.mexc.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/* ---------- response shapes ---------- */

interface MexcTrader {
  traderId?: string | number
  uid?: string | number
  id?: string | number
  userId?: string | number
  nickName?: string
  nickname?: string
  name?: string
  displayName?: string
  traderName?: string
  avatar?: string
  avatarUrl?: string
  headImg?: string
  roi?: number | string
  totalRoi?: number | string
  pnlRate?: number | string
  pnl?: number | string
  totalPnl?: number | string
  profit?: number | string
  winRate?: number | string
  mdd?: number | string
  maxDrawdown?: number | string
  followerCount?: number | string
  copierCount?: number | string
  followers?: number | string
}

interface MexcApiResponse {
  success?: boolean
  code?: number
  data?: {
    resultList?: MexcTrader[]  // legacy endpoint: { code: 0, data: { resultList: [...] } }
    list?: MexcTrader[]        // futures endpoint: { data: { list: [...] } }
    items?: MexcTrader[]
    traders?: MexcTrader[]
    rows?: MexcTrader[]
    total?: number
    totalPage?: number
    totalCount?: number
  } | MexcTrader[]
}

/* ---------- parser ---------- */

function extractList(data: MexcApiResponse): MexcTrader[] {
  if (!data?.data) return []
  if (Array.isArray(data.data)) return data.data
  return data.data.resultList || data.data.list || data.data.items || data.data.traders || data.data.rows || []
}

function parseTrader(item: MexcTrader, period: string): TraderData | null {
  const id = String(item.traderId || item.uid || item.id || item.userId || '')
  if (!id) return null

  const nickname = item.nickName || item.nickname || item.name || item.displayName || item.traderName
  if (!nickname || nickname.includes('*****') || nickname.startsWith('Trader_') || nickname.startsWith('Mexctrader-')) {
    return null
  }

  let roi = parseNum(item.roi ?? item.totalRoi ?? item.pnlRate)
  if (roi === null || roi === 0) return null
  // If ROI is in decimal form (0.5432 = 54.32%), convert to percentage
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.pnl ?? item.totalPnl ?? item.profit)

  let winRate = parseNum(item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.mdd ?? item.maxDrawdown)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.copierCount ?? item.followers)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: nickname,
    profile_url: `https://www.mexc.com/futures/copyTrade/detail/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
      avatar_url: item.avatar || item.avatarUrl || item.headImg || null,
  }
}

/* ---------- fetching ---------- */

/**
 * MEXC has two working API patterns (from lib/connectors/):
 * 1. POST https://www.mexc.com/api/platform/copy-trade/rank/list
 *    Body: { pageNum, pageSize, periodType: 1|2|3, sortField: "ROI" }
 *    Response: { code: 0, data: { resultList: [...] } }
 * 2. GET https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list
 *    Query: page, pageSize, sortField=yield, sortType=DESC, timeType=1|2|3
 *    Response: { data: { list: [...] } }
 */
const PERIOD_TYPE: Record<string, number> = { '7D': 1, '30D': 2, '90D': 3 }

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, MexcTrader>()
  let lastError = ''
  const periodType = PERIOD_TYPE[period] ?? 3

  // Strategy 1: POST to legacy copy-trade rank/list endpoint
  const tryLegacyApi = async () => {
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = 'https://www.mexc.com/api/platform/copy-trade/rank/list'
        const { data } = await fetchWithFallback<MexcApiResponse>(url, {
          method: 'POST',
          headers: {
            ...HEADERS,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          },
          body: {
            pageNum: page,
            pageSize: PAGE_SIZE,
            periodType,
            sortField: 'ROI',
          },
          platform: SOURCE,
        })
        const list = extractList(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.traderId || item.uid || item.id || item.userId || '')
          if (id && !allTraders.has(id)) allTraders.set(id, item)
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(500)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        break
      }
    }
  }

  // Strategy 2: GET from futures.mexc.com copy-trading trader/list
  const tryFuturesApi = async () => {
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list?page=${page}&pageSize=${PAGE_SIZE}&sortField=yield&sortType=DESC&timeType=${periodType}`
        const { data } = await fetchWithFallback<MexcApiResponse>(url, { headers: HEADERS, platform: SOURCE })
        const list = extractList(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.traderId || item.uid || item.id || item.userId || '')
          if (id && !allTraders.has(id)) allTraders.set(id, item)
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(500)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        break
      }
    }
  }

  // Try each strategy in order; stop at first success
  await tryLegacyApi()
  if (allTraders.size === 0) {
    await tryFuturesApi()
  }

  // VPS Playwright scraper fallback (browser-based bypass for Akamai WAF)
  if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
    logger.warn(`[${SOURCE}] All HTTP methods failed, trying VPS Playwright scraper...`)
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/mexc/leaderboard?periodType=${periodType}&pageSize=${PAGE_SIZE}`
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(120_000),
      })
      if (res.ok) {
        const data = (await res.json()) as MexcApiResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.traderId || item.uid || item.id || item.userId || '')
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
    return { total: 0, saved: 0, error: lastError || 'No data from MEXC — all endpoints and VPS scraper failed' }
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

export async function fetchMexc(
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
