/**
 * Bitget Spot — Inline fetcher for Vercel serverless
 *
 * Same authentication strategy as bitget-futures.ts.
 * See that file for detailed notes on API status.
 *
 * [WARN] Public endpoints return 404 as of 2025.
 * Requires BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE for broker API.
 *
 * Original: scripts/import/import_bitget_spot_v2.mjs (Puppeteer-based)
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
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitget_spot'
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_MAP: Record<string, string> = {
  '7D': 'SEVEN_DAYS',
  '30D': 'THIRTY_DAYS',
  '90D': 'NINETY_DAYS',
}

// ---------------------------------------------------------------------------
// Authentication
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

interface BitgetSpotTrader {
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
}

interface BitgetResponse {
  code?: string | number
  msg?: string
  data?: {
    traderList?: BitgetSpotTrader[]
    list?: BitgetSpotTrader[]
    total?: number
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseTrader(item: BitgetSpotTrader, period: string, rank: number): TraderData | null {
  const id = item.traderId || item.traderUid || String(item.uid || '')
  if (!id) return null

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

  const followers = parseNum(item.followerCount ?? item.copyTraderCount ?? item.currentCopiers)
  const handle = item.nickName || item.traderName || `BitgetSpot_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.bitget.com/copy-trading/trader/${id}/spot`,
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
// Fetching
// ---------------------------------------------------------------------------

async function fetchWithAuth(period: string): Promise<BitgetSpotTrader[]> {
  const creds = getBitgetCredentials()
  if (!creds) return []

  const allTraders: BitgetSpotTrader[] = []
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const periodParam = PERIOD_MAP[period] || period

  // Try broker spot endpoint, fall back to mix broker endpoint
  const brokerPaths = [
    '/api/v2/copy/spot-broker/query-traders',
    '/api/v2/copy/mix-broker/query-traders',
  ]

  for (const basePath of brokerPaths) {
    if (allTraders.length > 0) break

    for (let page = 1; page <= maxPages; page++) {
      try {
        const queryString = `pageNo=${page}&pageSize=${PAGE_SIZE}&period=${periodParam}`
        const path = `${basePath}?${queryString}`
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

        if (data.code !== '00000' && data.code !== 0 && data.code !== '0') break

        const list = data.data?.traderList || data.data?.list || []
        if (list.length === 0) break

        allTraders.push(...list)
        if (list.length < PAGE_SIZE || allTraders.length >= TARGET) break
        await sleep(300)
      } catch (err) {
        logger.warn(`[${SOURCE}] Pagination error: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
  }

  return allTraders
}

async function fetchPublic(period: string): Promise<BitgetSpotTrader[]> {
  const allTraders: BitgetSpotTrader[] = []
  const periodParam = PERIOD_MAP[period] || period
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)

  const urls = [
    'https://api.bitget.com/api/v2/copy/spot-trader/trader-profit-ranking',
    'https://api.bitget.com/api/v2/copy/spot-trader/query-trader-list',
  ]

  for (const apiUrl of urls) {
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
      } catch (err) {
        logger.warn(`[${SOURCE}] Pagination error: ${err instanceof Error ? err.message : String(err)}`)
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
  let rawTraders = await fetchWithAuth(period)
  if (rawTraders.length === 0) {
    rawTraders = await fetchPublic(period)
  }

  if (rawTraders.length === 0) {
    const hasCreds = !!getBitgetCredentials()
    return {
      total: 0,
      saved: 0,
      error: hasCreds
        ? 'Bitget spot broker API returned no data'
        : 'No data — set BITGET_API_KEY/SECRET/PASSPHRASE for broker API, or public endpoints are 404',
    }
  }

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

export async function fetchBitgetSpot(
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
