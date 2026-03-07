/**
 * BingX — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_bingx.mjs (Playwright-based with API interception)
 *
 * [WARN] CF-PROTECTED: All API endpoints are behind Cloudflare challenge.
 * The original script uses Playwright to bypass CF and intercept internal API calls.
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
  normalizeROI,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'
// Dynamic import to avoid bundling puppeteer on Vercel
const getInterceptApiResponses = () => import('../scrapers/cloudflare-bypass').then(m => m.interceptApiResponses)

const SOURCE = 'bingx'
const TARGET = 500
const PAGE_SIZE = 50

/** BingX period type mapping */
const PERIOD_MAP: Record<string, number> = {
  '7D': 1,
  '30D': 2,
  '90D': 3,
}

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://bingx.com/en/CopyTrading/leaderBoard',
  Origin: 'https://bingx.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
}

const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

/** Working API endpoints — api-app.qq-os.com is BingX's real internal API domain */
const API_ENDPOINTS = [
  // Primary: Real internal API (used by CF Worker, confirmed working)
  (page: number, periodType: number) =>
    `https://api-app.qq-os.com/api/copy-trade-facade/v2/leaderboard/rank?pageIndex=${page}&pageSize=${PAGE_SIZE}&timeType=${periodType}`,
  // Fallback: BingX domain copy trading endpoints
  (page: number, periodType: number) =>
    `https://bingx.com/api/copytrading/v1/leaderboard?pageIndex=${page}&pageSize=${PAGE_SIZE}&timeType=${periodType}`,
  (page: number, periodType: number) =>
    `https://bingx.com/api/strategy/api/v1/copy/trader/topRanking?type=${periodType}&pageIndex=${page}&pageSize=${PAGE_SIZE}`,
]

interface BingxTrader {
  uniqueId?: string
  uid?: string
  traderId?: string
  id?: string
  traderName?: string
  nickname?: string
  nickName?: string
  displayName?: string
  name?: string
  headUrl?: string
  avatar?: string
  avatarUrl?: string
  roi?: string | number
  roiRate?: string | number
  returnRate?: string | number
  pnlRatio?: string | number
  pnl?: string | number
  totalPnl?: string | number
  profit?: string | number
  winRate?: string | number
  maxDrawdown?: string | number
  followerNum?: number
  followers?: number
  followerCount?: number
}

interface BingxResponse {
  code?: number | string
  data?: {
    list?: BingxTrader[]
    rows?: BingxTrader[]
    records?: BingxTrader[]
    total?: number
  } | BingxTrader[]
  msg?: string
}

function parseTrader(item: BingxTrader, period: string, rank: number): TraderData | null {
  const id = String(item.uniqueId || item.uid || item.traderId || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.roiRate ?? item.returnRate ?? item.pnlRatio)
  if (roi === null) return null
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.pnl ?? item.totalPnl ?? item.profit)

  let winRate = parseNum(item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.followerNum ?? item.followers ?? item.followerCount)
  const handle = item.traderName || item.nickname || item.nickName || item.displayName || item.name || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://bingx.com/en/CopyTrading/tradeDetail/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
      avatar_url: item.headUrl || item.avatar || item.avatarUrl || null,
  }
}

function extractList(data: BingxResponse): BingxTrader[] {
  if (!data) return []
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { list?: BingxTrader[]; rows?: BingxTrader[]; records?: BingxTrader[] }
    return d.list || d.rows || d.records || []
  }
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodType = PERIOD_MAP[period] || 2
  const allTraders = new Map<string, BingxTrader>()

  // Try each endpoint until one returns data
  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, periodType)
        const data = await fetchJson<BingxResponse>(url, { headers: HEADERS, timeoutMs: 10000 })

        const list = extractList(data)
        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        let newCount = 0
        for (const item of list) {
          const id = String(item.uniqueId || item.uid || item.traderId || item.id || '')
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
        logger.warn(`[${SOURCE}] Page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }

    // If this endpoint returned some data, stop trying others
    if (allTraders.size > 0) break
  }

  // CF Worker proxy fallback — routes through Cloudflare to bypass CF challenge
  if (allTraders.size === 0) {
    logger.warn(`[${SOURCE}] Direct APIs failed, trying CF Worker proxy...`)
    try {
      // Use the dedicated /bingx/leaderboard shortcut in the CF Worker
      const maxPagesProxy = Math.ceil(TARGET / PAGE_SIZE)
      for (let page = 1; page <= maxPagesProxy; page++) {
        const proxyUrl = `${PROXY_URL}/bingx/leaderboard?pageIndex=${page}&pageSize=${PAGE_SIZE}&timeType=${periodType}`
        const data = await fetchJson<BingxResponse>(proxyUrl, { timeoutMs: 15_000 })

        // Check for proxy error
        if ((data as unknown as { error?: string }).error) {
          logger.warn(`[${SOURCE}] CF proxy error: ${(data as unknown as { error: string }).error}`)
          break
        }

        const list = extractList(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.uniqueId || item.uid || item.traderId || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(300)
      }
      if (allTraders.size > 0) {
        logger.info(`[${SOURCE}] CF Worker proxy got ${allTraders.size} traders`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] CF Worker proxy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // VPS proxy fallback when CF Worker also fails
  if (allTraders.size === 0) {
    const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_SG
    if (vpsUrl) {
      logger.warn(`[${SOURCE}] Trying VPS proxy...`)
      const realApiUrl = `https://api-app.qq-os.com/api/copy-trade-facade/v2/leaderboard/rank?pageIndex=1&pageSize=${PAGE_SIZE}&timeType=${periodType}`
      try {
        const res = await fetch(vpsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
          },
          body: JSON.stringify({ url: realApiUrl, method: 'GET', headers: HEADERS }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          const data = (await res.json()) as BingxResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.uniqueId || item.uid || item.traderId || item.id || '')
            if (id && id !== 'undefined' && !allTraders.has(id)) allTraders.set(id, item)
          }
          if (allTraders.size > 0) {
            logger.info(`[${SOURCE}] VPS proxy got ${allTraders.size} traders`)
          }
        }
      } catch (err) {
        logger.warn(`[${SOURCE}] VPS proxy failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Stealth browser fallback when all HTTP methods fail
  if (allTraders.size === 0) {
    logger.warn(`[${SOURCE}] All HTTP methods failed, trying stealth browser fallback...`)
    try {
      const interceptApiResponses = await getInterceptApiResponses()
      const { responses } = await interceptApiResponses(
        'https://bingx.com/en/CopyTrading/leaderBoard',
        ['copy', 'trader', 'ranking', 'leaderboard', 'leaderBoard'],
        { proxy: process.env.STEALTH_PROXY || undefined, maxWaitMs: 20_000 }
      )
      for (const resp of responses) {
        try {
          const data = JSON.parse(resp.body) as BingxResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.uniqueId || item.uid || item.traderId || item.id || '')
            if (id && id !== 'undefined' && !allTraders.has(id)) allTraders.set(id, item)
          }
        } catch { /* skip unparseable */ }
      }
      if (allTraders.size > 0) {
        logger.warn(`[${SOURCE}] Stealth browser got ${allTraders.size} traders`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] Stealth browser fallback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from BingX API endpoints (likely CF-protected)' }
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

export async function fetchBingx(
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
