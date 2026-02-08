/**
 * Bitget Futures — Inline fetcher for Vercel serverless
 *
 * Bitget copy trading public API endpoints (v2/copy/mix-trader/*) have been
 * removed/return 404 as of 2025. The authenticated broker API
 * (v2/copy/mix-broker/query-traders) exists but requires BITGET_API_KEY,
 * BITGET_API_SECRET, and BITGET_API_PASSPHRASE.
 *
 * The website uses /v1/trigger/trace/public/traderViewV3 but it's behind
 * Cloudflare protection (requires browser session).
 *
 * Strategy:
 * 1. Try authenticated broker API if env vars available
 * 2. Try known public endpoints as fallback (in case they come back)
 * 3. Return graceful error if nothing works
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
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { createHmac } from 'crypto'

const SOURCE = 'bitget_futures'
const TARGET = 500
const PAGE_SIZE = 50
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

/** Bitget API period values */
const PERIOD_MAP: Record<string, string> = {
  '7D': 'SEVEN_DAYS',
  '30D': 'THIRTY_DAYS',
  '90D': 'NINETY_DAYS',
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
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.totalProfit ?? item.profit)

  let winRate = parseNum(item.winRate)
  winRate = normalizeWinRate(winRate)

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
        console.warn(`[bitget-futures] Authenticated API error: ${data.code} ${data.msg}`)
        break
      }

      const list = data.data?.traderList || data.data?.list || []
      if (list.length === 0) break

      allTraders.push(...list)
      if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
      await sleep(300)
    } catch (err) {
      console.warn(`[bitget-futures] Auth fetch error: ${err}`)
      break
    }
  }

  return allTraders
}

// ---------------------------------------------------------------------------
// Public fallback endpoints (may return 404 but kept for future recovery)
// ---------------------------------------------------------------------------

const PUBLIC_API_URLS = [
  'https://api.bitget.com/api/v2/copy/mix-trader/trader-profit-ranking',
  'https://api.bitget.com/api/v2/copy/mix-trader/query-trader-list',
]

async function fetchPublic(period: string): Promise<BitgetTrader[]> {
  const allTraders: BitgetTrader[] = []
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const periodParam = PERIOD_MAP[period] || period

  // Strategy 1: Try direct public API endpoints
  for (const apiUrl of PUBLIC_API_URLS) {
    if (allTraders.length > 0) break

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `${apiUrl}?period=${periodParam}&pageNo=${page}&pageSize=${PAGE_SIZE}`
        const data = await fetchJson<BitgetResponse>(url, {
          headers: {
            Referer: 'https://www.bitget.com/',
            Origin: 'https://www.bitget.com',
            Accept: 'application/json',
          },
        })

        if (data.code !== '00000' && data.code !== 0 && data.code !== '0') break

        const list = data.data?.traderList || data.data?.list || []
        if (list.length === 0) break

        allTraders.push(...list)
        if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
        await sleep(300)
      } catch {
        break
      }
    }
  }

  // Strategy 2: Try Cloudflare Worker proxy if direct APIs failed
  if (allTraders.length === 0) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const proxyUrl = `${PROXY_URL}/bitget/copy-trading?period=${periodParam}&pageNo=${page}&pageSize=${PAGE_SIZE}&type=futures`
        const data = await fetchJson<BitgetResponse>(proxyUrl)

        // Check if proxy returned an error object
        if ((data as unknown as { error?: string }).error) {
          console.log(`[bitget-futures] Proxy error: ${(data as unknown as { error: string }).error}`)
          break
        }

        if (data.code !== '00000' && data.code !== 0 && data.code !== '0') break

        const list = data.data?.traderList || data.data?.list || []
        if (list.length === 0) break

        allTraders.push(...list)
        if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
        await sleep(300)
      } catch (err) {
        console.log(`[bitget-futures] Proxy fetch error: ${err}`)
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
        : 'No data — set BITGET_API_KEY/SECRET/PASSPHRASE for broker API, or public endpoints are 404',
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

  for (const period of periods) {
    result.periods[period] = await fetchPeriod(supabase, period)
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  result.duration = Date.now() - start
  return result
}
