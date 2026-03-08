/**
 * LBank — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_lbank.mjs (Puppeteer-based with Stealth plugin)
 *
 * [WARN] NO PUBLIC API: LBank doesn't have documented public APIs for copy trading.
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
  fetchWithFallback,
  sleep,
  parseNum,
  normalizeWinRate,
  getWinRateFormat,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'
// Dynamic import to avoid bundling puppeteer on Vercel
const getInterceptApiResponses = () => import('../scrapers/cloudflare-bypass').then(m => m.interceptApiResponses)

const SOURCE = 'lbank'
const TARGET = 500
const PAGE_SIZE = 50
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

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

/** LBank internal API (discovered 2026-03-06 via VPS browser debug)
 * Base: https://uuapi.rerrkvifj.com/futures-follow-center/trader/stat/v1/
 * sortField values: omProfitRate (ROI), omProfit (PnL), smFollowerIncome (follower income)
 */
const LBANK_API_BASE = 'https://uuapi.rerrkvifj.com/futures-follow-center/trader/stat/v1'

const API_ENDPOINTS = [
  // Primary — getAll with ROI sort (paginated, confirmed working)
  (page: number, _period: string) =>
    `${LBANK_API_BASE}/getAll?size=${PAGE_SIZE}&current=${page}&topFlag=1&sortField=omProfitRate&sortDirection=1`,
  // Fallback — getAll with PnL sort
  (page: number, _period: string) =>
    `${LBANK_API_BASE}/getAll?size=${PAGE_SIZE}&current=${page}&topFlag=1&sortField=omProfit&sortDirection=1`,
]

const EXTRA_ENDPOINTS = [
  `${LBANK_API_BASE}/queryBestTrader`,
  `${LBANK_API_BASE}/queryAddTrader`,
  `${LBANK_API_BASE}/getRecomm`,
]

interface LbankTrader {
  uuid?: string
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
  headPhoto?: string
  avatarUrl?: string
  photo?: string
  roi?: string | number
  roi7d?: string | number
  roi30d?: string | number
  returnRate?: string | number
  profitRate?: string | number
  omProfitRate?: string | number
  yield?: string | number
  pnl?: string | number
  profit?: string | number
  totalProfit?: string | number
  totalPnl?: string | number
  followerIncome?: string | number
  followerProfit7d?: string | number
  followerProfit30d?: string | number
  winRate?: string | number
  winRatio?: string | number
  swinRate?: string | number
  winRate30d?: string | number
  maxDrawdown?: string | number
  mdd?: string | number
  drawDown?: string | number
  followerCount?: number | string
  followers?: number | string
  copyCount?: number | string
  followNum?: number | string
  followerCountNow?: number | string
  maxFollowerCount?: number | string
}

interface LbankResponse {
  code?: number | string
  data?: {
    list?: LbankTrader[]
    traders?: LbankTrader[]
    records?: LbankTrader[]
    traderInfoResps?: LbankTrader[]
    total?: number
    current?: number
    pages?: number
    size?: number
  } | LbankTrader[]
  result?: {
    list?: LbankTrader[]
  }
  rows?: LbankTrader[]
  msg?: string
  message?: string
}

function parseTrader(item: LbankTrader, period: string, rank: number): TraderData | null {
  const id = String(item.uuid || item.uid || item.userId || item.traderId || item.id || item.memberId || '')
  if (!id || id === 'undefined') return null

  // LBank uses period-specific ROI fields: roi7d, roi30d
  let roi = parseNum(
    (period === '7D' ? item.roi7d : null)
    ?? (period === '30D' ? item.roi30d : null)
    ?? item.roi ?? item.omProfitRate ?? item.returnRate ?? item.profitRate ?? item.roi30d ?? item.roi7d ?? item.yield
  )
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

  const pnl = parseNum(item.pnl ?? item.profit ?? item.followerIncome ?? item.totalProfit ?? item.totalPnl)

  let winRate = parseNum(item.swinRate ?? item.winRate30d ?? item.winRate ?? item.winRatio)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.drawDown ?? item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCountNow ?? item.followerCount ?? item.followers ?? item.copyCount ?? item.followNum)
  const handle = item.nickname || item.nickName || item.name || item.userName || `Trader_${id.slice(0, 8)}`

  let avatarUrl = item.avatar || item.headUrl || item.avatarUrl || null
  if (!avatarUrl && item.headPhoto) {
    avatarUrl = item.headPhoto.startsWith('http') ? item.headPhoto : `https://file.lbank.zone${item.headPhoto}`
  }

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
    avatar_url: avatarUrl,
  }
}

function extractList(data: LbankResponse): LbankTrader[] {
  if (!data) return []

  // Direct array
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data

  // Nested data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { records?: LbankTrader[]; traderInfoResps?: LbankTrader[]; list?: LbankTrader[]; traders?: LbankTrader[] }
    if (d.records && Array.isArray(d.records)) return d.records
    if (d.traderInfoResps && Array.isArray(d.traderInfoResps)) return d.traderInfoResps
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

  const addTrader = (item: LbankTrader) => {
    const id = String(item.uuid || item.uid || item.userId || item.traderId || item.id || item.memberId || '')
    if (id && id !== 'undefined' && !allTraders.has(id)) allTraders.set(id, item)
  }

  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, periodStr)
        const { data } = await fetchWithFallback<LbankResponse>(url, { headers: HEADERS, timeoutMs: 10000, platform: SOURCE })

        const list = extractList(data)
        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        let newCount = 0
        for (const item of list) {
          const sizeBefore = allTraders.size
          addTrader(item)
          if (allTraders.size > sizeBefore) newCount++
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
        logger.warn(`[${SOURCE}] Pagination error: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }

    if (allTraders.size > 0) break
  }

  // Try extra non-paginated endpoints for more traders
  if (allTraders.size < TARGET) {
    for (const url of EXTRA_ENDPOINTS) {
      try {
        const { data } = await fetchWithFallback<LbankResponse>(url, { headers: HEADERS, timeoutMs: 10000, platform: SOURCE })
        const list = extractList(data)
        for (const item of list) addTrader(item)
      } catch { /* ignore extra endpoint failures */ }
    }
  }

  // VPS proxy fallback
  if (allTraders.size === 0) {
    const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_SG
    if (vpsUrl) {
      logger.warn(`[${SOURCE}] All direct endpoints failed, trying VPS proxy...`)
      try {
        const url = `${LBANK_API_BASE}/getAll?size=${PAGE_SIZE}&current=1&topFlag=1&sortField=omProfitRate&sortDirection=1`
        const res = await fetch(vpsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Proxy-Key': process.env.VPS_PROXY_KEY || '' },
          body: JSON.stringify({ url, method: 'GET', headers: HEADERS }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const data = (await res.json()) as LbankResponse
          const list = extractList(data)
          for (const item of list) addTrader(item)
          if (allTraders.size > 0) logger.warn(`[${SOURCE}] VPS proxy got ${allTraders.size} traders`)
        }
      } catch (err) {
        logger.warn(`[${SOURCE}] VPS proxy failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // VPS Playwright scraper fallback (browser-based bypass for CF challenge)
  if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
    logger.warn(`[${SOURCE}] Trying VPS Playwright scraper...`)
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/lbank/leaderboard?pageSize=${PAGE_SIZE}`
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const data = (await res.json()) as LbankResponse
        const list = extractList(data)
        for (const item of list) addTrader(item)
        if (allTraders.size > 0) logger.warn(`[${SOURCE}] VPS scraper got ${allTraders.size} traders`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Stealth browser fallback when all HTTP methods fail (CF JS challenge)
  if (allTraders.size === 0) {
    logger.warn(`[${SOURCE}] All HTTP methods failed, trying stealth browser fallback...`)
    try {
      const interceptApiResponses = await getInterceptApiResponses()
      const { responses } = await interceptApiResponses(
        'https://www.lbank.com/copy-trading',
        ['copy', 'trader', 'ranking', 'leader'],
        { proxy: process.env.STEALTH_PROXY || undefined, maxWaitMs: 20_000 }
      )
      for (const resp of responses) {
        try {
          const data = JSON.parse(resp.body) as LbankResponse
          const list = extractList(data)
          for (const item of list) addTrader(item)
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
    return { total: 0, saved: 0, error: 'No data from LBank — all endpoints, VPS proxy, and VPS scraper failed' }
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

export async function fetchLbank(
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
