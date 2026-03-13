/**
 * Gate.io — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_gateio.mjs (Playwright-based with API interception)
 *
 * ⚠️  AUTH REQUIRED: Gate.io API v4 copy trading endpoints exist and respond
 * at api.gateio.ws/api/v4/copy_trading/leader_board but require KEY header
 * (GATEIO_API_KEY and GATEIO_API_SECRET).
 * Website (www.gate.io) is Akamai WAF-blocked from US IPs.
 * Set GATEIO_API_KEY and GATEIO_API_SECRET to enable authenticated access.
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
} from './shared.js'
import { type StatsDetail, upsertStatsDetail } from './enrichment.js'
import { logger } from '../../logger.js'

const SOURCE = 'gateio'
const TARGET = 500
const PAGE_SIZE = 50

/** Gate.io period mapping */
const PERIOD_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': '90d',
}

const HEADERS: Record<string, string> = {
  Referer: 'https://www.gate.io/copy_trading',
  Origin: 'https://www.gate.io',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** Multiple API endpoints to try */
const API_ENDPOINTS = [
  // Internal web API patterns for Gate.io
  (page: number, period: string) =>
    `https://www.gate.io/apiw/v1/copytrade/leader/list?sort=roi&period=${period}&page=${page}&limit=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://www.gate.io/api/copytrade/leader/list?sort=roi&period=${period}&page=${page}&limit=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://www.gate.io/apiw/v2/copy_trading/leaders?sort_by=roi&period=${period}&page=${page}&page_size=${PAGE_SIZE}`,
  (page: number, period: string) =>
    `https://www.gate.io/api/v1/copy-trade/top_leaders?sort=roi&period=${period}&offset=${(page - 1) * PAGE_SIZE}&limit=${PAGE_SIZE}`,
]

interface GateTrader {
  user_id?: string
  uid?: string
  trader_id?: string
  id?: string | number
  userId?: string
  nickname?: string
  name?: string
  nickName?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  head_url?: string
  roi?: string | number
  profit_rate?: string | number
  pnl_ratio?: string | number
  returnRate?: string | number
  pnl?: string | number
  profit?: string | number
  totalPnl?: string | number
  win_rate?: string | number
  winRate?: string | number
  max_drawdown?: string | number
  maxDrawdown?: string | number
  follower_num?: number | string
  followers?: number | string
  followerCount?: number | string
  copier_num?: number | string
}

interface GateResponse {
  code?: number | string
  data?: {
    list?: GateTrader[]
    rows?: GateTrader[]
    records?: GateTrader[]
    items?: GateTrader[]
    total?: number
  } | GateTrader[]
  msg?: string
}

function parseTrader(item: GateTrader, period: string, rank: number): TraderData | null {
  const id = String(item.user_id || item.uid || item.trader_id || item.id || item.userId || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.profit_rate ?? item.pnl_ratio ?? item.returnRate)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.pnl ?? item.profit ?? item.totalPnl)

  let winRate = parseNum(item.win_rate ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.max_drawdown ?? item.maxDrawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.follower_num ?? item.followers ?? item.followerCount ?? item.copier_num)
  const handle = item.nickname || item.name || item.nickName || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.gate.io/copy_trading/share?trader_id=${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
  }
}

function extractList(data: GateResponse): GateTrader[] {
  if (!data) return []

  // Response could be a direct array
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data

  if (data.data && typeof data.data === 'object') {
    const d = data.data as {
      list?: GateTrader[]
      rows?: GateTrader[]
      records?: GateTrader[]
      items?: GateTrader[]
    }
    return d.list || d.rows || d.records || d.items || []
  }

  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30d'
  const allTraders = new Map<string, GateTrader>()

  // Try each endpoint until one returns data
  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    let consecutiveEmpty = 0
    const maxPages = Math.ceil(TARGET / PAGE_SIZE)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = buildUrl(page, periodStr)
        const data = await fetchJson<GateResponse>(url, { headers: HEADERS, timeoutMs: 10000 })

        const list = extractList(data)
        if (list.length === 0) {
          consecutiveEmpty++
          if (consecutiveEmpty >= 2) break
          continue
        }

        let newCount = 0
        for (const item of list) {
          const id = String(item.user_id || item.uid || item.trader_id || item.id || item.userId || '')
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
      } catch {
        break
      }
    }

    if (allTraders.size > 0) break
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from Gate.io API endpoints (likely CF-protected)' }
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

export async function fetchGateio(
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
