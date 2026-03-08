/**
 * CoinEx — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_coinex.mjs (276 lines, puppeteer + DOM scraping)
 *
 * CoinEx copy trading page: https://www.coinex.com/en/copy-trading/futures
 *
 * Working endpoints (from lib/connectors/coinex.ts + platforms/coinex-futures.ts):
 * 1. GET https://www.coinex.com/res/copy-trade/rank (period=7d/30d/90d)
 * 2. GET https://www.coinex.com/res/copy-trading/traders (period=7d/30d)
 * Note: CoinEx does NOT support 90d on the platform endpoint.
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

const SOURCE = 'coinex'
const TARGET = 500
const PAGE_SIZE = 50
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''
const VPS_PROXY_URL = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP || ''
const VPS_PROXY_KEY = process.env.VPS_PROXY_KEY || ''

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
  account_name?: string
  name?: string
  avatar?: string
  avatar_url?: string
  roi?: number | string
  roi_rate?: number | string
  return_rate?: number | string
  profit_rate?: number | string
  pnl?: number | string
  profit?: number | string
  total_pnl?: number | string
  total_profit?: number | string
  win_rate?: number | string
  winRate?: number | string
  max_drawdown?: number | string
  maxDrawdown?: number | string
  mdd?: number | string
  follower_count?: number | string
  followerCount?: number | string
  copier_num?: number | string
  cur_follower_num?: number | string
  status?: string
}

interface CoinexApiResponse {
  code?: number
  message?: string
  data?: {
    data?: CoinexTrader[]     // legacy endpoint: { code: 0, data: { data: [...] } }
    items?: CoinexTrader[]    // platform endpoint: { data: { items: [...] } }
    list?: CoinexTrader[]
    traders?: CoinexTrader[]
    rows?: CoinexTrader[]
    total?: number
    page_count?: number
  } | CoinexTrader[]
}

/* ---------- parser ---------- */

function extractList(resp: CoinexApiResponse): CoinexTrader[] {
  if (!resp?.data) return []
  if (Array.isArray(resp.data)) return resp.data
  return resp.data.data || resp.data.items || resp.data.list || resp.data.traders || resp.data.rows || []
}

function parseTrader(item: CoinexTrader, period: string): TraderData | null {
  const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
  if (!id) return null

  const nickname = item.nick_name || item.nickName || item.nickname || item.account_name || item.name || ''
  if (!nickname) return null

  let roi = parseNum(item.roi ?? item.roi_rate ?? item.return_rate ?? item.profit_rate)
  if (roi === null || roi === 0) return null
  // CoinEx may use decimal or percentage — normalize
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.pnl ?? item.profit ?? item.total_pnl ?? item.total_profit)

  let winRate = parseNum(item.win_rate ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.max_drawdown ?? item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.follower_count ?? item.followerCount ?? item.copier_num ?? item.cur_follower_num)

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
      avatar_url: item.avatar || item.avatar_url || null,
  }
}

/* ---------- fetching ---------- */

/**
 * Working CoinEx API endpoints (from lib/connectors/coinex.ts + platforms/coinex-futures.ts):
 * 1. GET https://www.coinex.com/res/copy-trade/rank (period=7d/30d/90d, page, limit, sort=roi)
 *    Response: { code: 0, data: { data: [...] } }
 * 2. GET https://www.coinex.com/res/copy-trading/traders (page, limit, sort_by=roi, period=7d/30d)
 *    Response: { data: { items: [...] } }
 */
const PERIOD_MAP: Record<string, string> = { '7D': '7d', '30D': '30d', '90D': '90d' }
const TIME_RANGE_MAP: Record<string, string> = { '7D': 'DAY7', '30D': 'DAY30', '90D': 'DAY90' }

const API_ENDPOINTS = [
  // Primary — public/traders endpoint (confirmed working 2026-03-06 via VPS browser debug)
  (page: number, period: string) =>
    `https://www.coinex.com/res/copy-trading/public/traders?data_type=profit_rate&time_range=${TIME_RANGE_MAP[period] || 'DAY30'}&hide_full=0&page=${page}&limit=${PAGE_SIZE}`,
  // Fallback — legacy connector (copy-trade/rank)
  (page: number, period: string) =>
    `https://www.coinex.com/res/copy-trade/rank?period=${PERIOD_MAP[period] || '30d'}&page=${page}&limit=${PAGE_SIZE}&sort=roi`,
  // Fallback — platform connector (copy-trading/traders)
  (page: number, period: string) =>
    `https://www.coinex.com/res/copy-trading/traders?page=${page}&limit=${PAGE_SIZE}&sort_by=roi&period=${PERIOD_MAP[period] || '30d'}`,
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
        const url = makeUrl(page, period)
        const { data } = await fetchWithFallback<CoinexApiResponse>(url, { headers: HEADERS, platform: SOURCE })

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

  // Strategy 2: VPS proxy with pagination — bypass Cloudflare via server-to-server request from SG VPS
  if (allTraders.size < TARGET && VPS_PROXY_URL) {
    logger.warn(`[${SOURCE}] Direct HTTP got ${allTraders.size} traders, trying VPS proxy with pagination...`)

    const VPS_PROXY_ENDPOINTS = [
      // Primary — public/traders (confirmed working via VPS browser)
      (page: number) =>
        `https://www.coinex.com/res/copy-trading/public/traders?data_type=profit_rate&time_range=${TIME_RANGE_MAP[period] || 'DAY30'}&hide_full=0&page=${page}&limit=${PAGE_SIZE}`,
      // Fallback — copy-trade/rank
      (page: number) =>
        `https://www.coinex.com/res/copy-trade/rank?period=${PERIOD_MAP[period] || '30d'}&page=${page}&limit=${PAGE_SIZE}&sort=roi`,
    ]

    for (const makeUrl of VPS_PROXY_ENDPOINTS) {
      if (allTraders.size >= TARGET) break
      const maxPages = Math.ceil(TARGET / PAGE_SIZE)
      let consecutiveEmpty = 0

      for (let page = 1; page <= maxPages; page++) {
        try {
          const targetUrl = makeUrl(page)
          const res = await fetch(VPS_PROXY_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Proxy-Key': VPS_PROXY_KEY,
            },
            body: JSON.stringify({
              url: targetUrl,
              method: 'GET',
              headers: {
                ...HEADERS,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              },
            }),
            signal: AbortSignal.timeout(20_000),
          })

          if (!res.ok) {
            logger.warn(`[${SOURCE}] VPS proxy HTTP ${res.status} on page ${page}`)
            break
          }

          const data = (await res.json()) as CoinexApiResponse

          // Skip "unknown method" responses
          if (data?.code === 4009) {
            logger.warn(`[${SOURCE}] VPS proxy got code 4009 (unknown method), trying next endpoint`)
            break
          }

          const list = extractList(data)
          if (list.length === 0) {
            consecutiveEmpty++
            if (consecutiveEmpty >= 2) break
            continue
          }
          consecutiveEmpty = 0

          let newCount = 0
          for (const item of list) {
            const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
            if (id && !allTraders.has(id)) {
              allTraders.set(id, item)
              newCount++
            }
          }

          logger.warn(`[${SOURCE}] VPS proxy page ${page}: ${list.length} items, ${newCount} new (total: ${allTraders.size})`)

          if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
          await sleep(800) // polite delay between pages
        } catch (err) {
          logger.warn(`[${SOURCE}] VPS proxy page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
          break
        }
      }

      if (allTraders.size > 0) {
        logger.warn(`[${SOURCE}] VPS proxy total: ${allTraders.size} traders`)
        break // got data from this endpoint, no need to try fallback
      }
    }
  }

  // Strategy 3: VPS Playwright scraper fallback (browser-based bypass for CF challenge)
  if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
    logger.warn(`[${SOURCE}] VPS proxy failed, trying VPS Playwright scraper...`)
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/coinex/leaderboard?period=${PERIOD_MAP[period] || '30d'}&pageSize=${PAGE_SIZE}`
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const data = (await res.json()) as CoinexApiResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.trader_id || item.traderId || item.uid || item.id || '')
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
    return { total: 0, saved: 0, error: lastError || 'No data from CoinEx — all endpoints and VPS scraper failed' }
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

export async function fetchCoinex(
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
