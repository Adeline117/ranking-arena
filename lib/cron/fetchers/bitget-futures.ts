/**
 * Bitget Futures — Inline fetcher for Vercel serverless
 *
 * Strategy:
 * 1. Try authenticated broker API if env vars available (v2/copy/mix-broker)
 * 2. Try V1 public endpoint (api/mix/v1/trace/traderList — still working)
 * 3. Try V2 public endpoints as fallback
 * 4. Try CF Worker and VPS proxy
 * 5. Return graceful error if nothing works
 *
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
  normalizeROI,
  getWinRateFormat,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { createHmac } from 'crypto'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitget_futures'
const TARGET = 500
const PAGE_SIZE = 50
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
// VPS Playwright scraper for WAF-protected exchanges
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

/** Bitget API period values (for REST API v2) */
const PERIOD_MAP: Record<string, string> = {
  '7D': 'SEVEN_DAYS',
  '30D': 'THIRTY_DAYS',
  '90D': 'NINETY_DAYS',
}

/** Bitget website API sortType values (for POST /v1/copy/mix/trader/list) */
const SORT_TYPE_MAP: Record<string, number> = {
  '7D': 1,
  '30D': 2,
  '90D': 0,
}

// ---------------------------------------------------------------------------
// Authentication helpers (for Bitget API v2 broker endpoints)
// ---------------------------------------------------------------------------

function getBitgetCredentials(): { apiKey: string; secret: string; passphrase: string } | null {
  const apiKey = process.env.BITGET_API_KEY || ''
  const secret = process.env.BITGET_API_SECRET || ''
  const passphrase = process.env.BITGET_API_PASSPHRASE || ''
  if (!apiKey || !secret || !passphrase) return null
  return { apiKey, secret, passphrase }
}

function signBitgetRequest(
  timestamp: string,
  method: string,
  path: string,
  body: string,
  secret: string
): string {
  const message = timestamp + method.toUpperCase() + path + body
  return createHmac('sha256', secret).update(message).digest('base64')
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseTrader(item: BitgetTrader, period: string, rank: number): TraderData | null {
  const id = item.traderId || item.traderUid || String(item.uid || '')
  if (!id) return null

  // ROI: Bitget returns as decimal (0.1234 = 12.34%) or percentage
  let roi = parseNum(item.profitRate ?? item.roi ?? item.yieldRate)
  if (roi === null) return null
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.totalProfit ?? item.profit)

  let winRate = parseNum(item.winRate)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(
    item.followerCount ?? item.copyTraderCount ?? item.currentCopiers ?? item.copyUserNum
  )
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
      avatar_url: item.headUrl || item.avatar || null,
  }
}

// ---------------------------------------------------------------------------
// Authenticated broker API fetch
// ---------------------------------------------------------------------------

async function fetchWithAuth(period: string): Promise<BitgetTrader[]> {
  const creds = getBitgetCredentials()
  if (!creds) return []

  const allTraders: BitgetTrader[] = []
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const periodParam = PERIOD_MAP[period] || period

  for (let page = 1; page <= maxPages; page++) {
    try {
      const queryString = `pageNo=${page}&pageSize=${PAGE_SIZE}&period=${periodParam}`
      const path = `/api/v2/copy/mix-broker/query-traders?${queryString}`
      const timestamp = Date.now().toString()
      const sign = signBitgetRequest(timestamp, 'GET', path, '', creds.secret)

      const url = `https://api.bitget.com${path}`
      const data = await fetchJson<BitgetResponse>(url, {
        headers: {
          'ACCESS-KEY': creds.apiKey,
          'ACCESS-SIGN': sign,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': creds.passphrase,
          'Content-Type': 'application/json',
          locale: 'en-US',
        },
      })

      if (data.code !== '00000' && data.code !== 0 && data.code !== '0') {
        logger.warn(`[bitget-futures] Authenticated API error: ${data.code} ${data.msg}`)
        break
      }

      const list = data.data?.traderList || data.data?.list || []
      if (list.length === 0) break

      allTraders.push(...list)
      if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
      await sleep(300)
    } catch (err) {
      logger.warn(`[bitget-futures] Auth fetch error: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  return allTraders
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

// Working endpoint: POST /v1/trigger/trace/public/traderList (discovered 2026-03-06)
// Returns: { code: "00000", data: { rows: [...], nextFlag: true } }
const TRACE_API_URL = 'https://www.bitget.com/v1/trigger/trace/public/traderList'

// Legacy endpoint (no longer works — kept as fallback)
const WEBSITE_API_URL = 'https://www.bitget.com/v1/copy/mix/trader/list'

const RANDOM_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
]

async function fetchPublic(period: string): Promise<BitgetTrader[]> {
  const allTraders: BitgetTrader[] = []
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const periodParam = PERIOD_MAP[period] || period

  // Strategy 1: VPS Playwright scraper (browser bypasses Cloudflare challenge)
  // Each page = 1 browser session (~60s), so use large pageSize to minimize sessions
  const VPS_PAGE_SIZE = 100
  const VPS_MAX_PAGES = 3 // 300 traders max, ~3 browser sessions ≈ 3min
  if (VPS_SCRAPER_KEY) {
    try {
      logger.warn(`[${SOURCE}] Trying VPS Playwright scraper...`)
      for (let page = 1; page <= VPS_MAX_PAGES; page++) {
        const url = `${VPS_SCRAPER_URL}/bitget/leaderboard?pageNo=${page}&pageSize=${VPS_PAGE_SIZE}&period=${periodParam}`
        const res = await fetch(url, {
          headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
          signal: AbortSignal.timeout(90_000),
        })
        if (!res.ok) break
        const data = (await res.json()) as BitgetResponse
        if (data.code !== '00000' && data.code !== 0 && data.code !== '0') break
        const list = data.data?.traderList || data.data?.list || []
        if (list.length === 0) break
        allTraders.push(...list)
        if (list.length < VPS_PAGE_SIZE || allTraders.length >= TARGET) break
        await sleep(1000)
      }
      if (allTraders.length > 0) {
        logger.info(`[${SOURCE}] VPS scraper got ${allTraders.length} traders`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Strategy 2: Direct trace API call (may be blocked by CF WAF, but worth trying)
  if (allTraders.length === 0) {
    const sortType = SORT_TYPE_MAP[period] ?? 2
    for (let page = 1; page <= Math.min(maxPages, 3); page++) {
      try {
        const data = await fetchJson<BitgetResponse & { data?: { rows?: BitgetTrader[]; nextFlag?: boolean } }>(TRACE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': RANDOM_UAS[Math.floor(Math.random() * RANDOM_UAS.length)],
            'Referer': 'https://www.bitget.com/copy-trading',
            'Origin': 'https://www.bitget.com',
          },
          body: { pageNo: page, pageSize: PAGE_SIZE, sortField: 'ROI', sortType, rule: 2 },
        })
        if (data.code !== '0' && data.code !== 0 && data.code !== '00000') break
        const list = data.data?.rows || data.data?.traderList || data.data?.list || []
        if (list.length === 0) break
        allTraders.push(...list)
        if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
        await sleep(500)
      } catch (err) {
        logger.warn(`[${SOURCE}] Trace API direct call failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
    if (allTraders.length > 0) {
      logger.info(`[${SOURCE}] Trace API direct call got ${allTraders.length} traders`)
    }
  }

  // Strategy 3: Legacy website API (fallback)
  if (allTraders.length === 0) {
    const sortType = SORT_TYPE_MAP[period] ?? 2
    for (let page = 1; page <= Math.min(maxPages, 3); page++) {
      try {
        const data = await fetchJson<BitgetResponse>(WEBSITE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': RANDOM_UAS[Math.floor(Math.random() * RANDOM_UAS.length)],
          },
          body: { pageNo: page, pageSize: PAGE_SIZE, sortField: 'ROI', sortType, rule: 2 },
        })
        if (data.code !== '0' && data.code !== 0 && data.code !== '00000') break
        const list = data.data?.list || data.data?.traderList || []
        if (list.length === 0) break
        allTraders.push(...list)
        if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
        await sleep(500)
      } catch (err) {
        logger.warn(`[${SOURCE}] Legacy API failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
  }

  return allTraders
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // 1. Try authenticated broker API first
  let rawTraders = await fetchWithAuth(period)

  // 2. Fall back to public endpoints
  if (rawTraders.length === 0) {
    rawTraders = await fetchPublic(period)
  }

  if (rawTraders.length === 0) {
    const hasCreds = !!getBitgetCredentials()
    return {
      total: 0,
      saved: 0,
      error: hasCreds
        ? 'Bitget broker API returned no data'
        : 'No data — public endpoints return 404. Set BITGET_API_KEY/SECRET/PASSPHRASE for broker API (/api/v2/copy/mix-broker/query-traders)',
    }
  }

  // Deduplicate
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function fetchBitgetFutures(
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
