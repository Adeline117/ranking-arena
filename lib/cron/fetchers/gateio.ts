/**
 * Gate.io — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_gateio.mjs (Playwright-based with API interception)
 *
 * [WARN] AUTH REQUIRED: Gate.io API v4 copy trading endpoints exist and respond
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
  normalizeROI,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

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

/**
 * Build Gate.io API v4 authentication headers (HMAC-SHA512).
 * See: https://www.gate.io/docs/developers/apiv4/#authentication
 */
function buildAuthHeaders(
  method: string,
  path: string,
  query: string,
  body: string = ''
): Record<string, string> | null {
  const apiKey = process.env.GATEIO_API_KEY
  const apiSecret = process.env.GATEIO_API_SECRET
  if (!apiKey || !apiSecret) return null

  // Gate.io v4 requires: KEY, SIGN, Timestamp
  // SIGN = HMAC-SHA512(apiSecret, method + '\n' + path + '\n' + query + '\n' + sha512(body) + '\n' + timestamp)
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- crypto is a Node.js built-in; dynamic require avoids bundler issues
  const crypto = require('crypto')
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const bodyHash = crypto.createHash('sha512').update(body).digest('hex')
  const signString = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`
  const sign = crypto.createHmac('sha512', apiSecret).update(signString).digest('hex')

  return {
    KEY: apiKey,
    SIGN: sign,
    Timestamp: timestamp,
  }
}

/** Gate.io period → cycle mapping for web API */
const CYCLE_MAP: Record<string, string> = {
  '7d': 'week',
  '30d': 'month',
  '90d': 'quarter',
}

/** Multiple API endpoints to try */
const API_ENDPOINTS = [
  // Discovered working endpoint (gate.com/apiw/v2/copy) — no auth needed
  (page: number, period: string) =>
    `https://www.gate.com/apiw/v2/copy/leader/list?page=${page}&page_size=${PAGE_SIZE}&order_by=profit_rate&sort_by=desc&cycle=${CYCLE_MAP[period] || 'month'}&status=running`,
  // Alternative sort orders on same endpoint
  (page: number, period: string) =>
    `https://www.gate.com/apiw/v2/copy/leader/list?page=${page}&page_size=${PAGE_SIZE}&order_by=profit&sort_by=desc&cycle=${CYCLE_MAP[period] || 'month'}&status=running`,
  // Recommend list endpoint
  (page: number, period: string) =>
    `https://www.gate.com/apiw/v2/copy/leader/recommend_list?params[page]=${page}&params[page_size]=${PAGE_SIZE}&params[cycle]=${CYCLE_MAP[period] || 'month'}`,
  // Gate.io API v4 authenticated endpoint (fallback)
  (page: number, period: string) =>
    `https://api.gateio.ws/api/v4/copy_trading/leader_board?sort_by=roi&period=${period}&page=${page}&limit=${PAGE_SIZE}`,
]

interface GateTrader {
  // IDs
  leader_id?: number | string
  user_id?: string
  uid?: string
  trader_id?: string
  id?: string | number
  userId?: string
  // Names (from user_info nested object or top-level)
  nickname?: string
  name?: string
  nickName?: string
  displayName?: string
  user_info?: {
    nick?: string
    nickname?: string
    avatar?: string
    tier?: number
  }
  // Images
  avatar?: string
  avatarUrl?: string
  head_url?: string
  // ROI / Profit
  roi?: string | number
  profit_rate?: string | number
  pnl_ratio?: string | number
  returnRate?: string | number
  pl_ratio?: string | number
  // PnL
  pnl?: string | number
  profit?: string | number
  totalPnl?: string | number
  follow_profit?: string | number
  // Stats
  win_rate?: string | number
  winRate?: string | number
  max_drawdown?: string | number
  maxDrawdown?: string | number
  sharp_ratio?: string | number
  aum?: string | number
  leading_days?: number
  // Followers
  curr_follow_num?: number | string
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
  const id = String(item.leader_id || item.user_id || item.uid || item.trader_id || item.id || item.userId || '')
  if (!id || id === 'undefined') return null

  // profit_rate from gate.com API is decimal (e.g. 9.5402 = 954.02%)
  let roi = parseNum(item.roi ?? item.profit_rate ?? item.pnl_ratio ?? item.returnRate)
  if (roi === null) return null
  // Normalize ROI (Gate.io returns ratio: 1.0 = 100%)
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.pnl ?? item.profit ?? item.totalPnl ?? item.follow_profit)

  let winRate = parseNum(item.win_rate ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.max_drawdown ?? item.maxDrawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.curr_follow_num ?? item.follower_num ?? item.followers ?? item.followerCount ?? item.copier_num)
  const handle = item.user_info?.nickname || item.user_info?.nick || item.nickname || item.name || item.nickName || item.displayName || `Trader_${id.slice(0, 8)}`
  const avatar = item.user_info?.avatar || item.avatar || item.avatarUrl || item.head_url || null

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.gate.com/copytrading/trader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: avatar,
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
        const urlObj = new URL(url)
        const isV4 = url.includes('api.gateio.ws/api/v4/')
        const reqHeaders: Record<string, string> = { ...HEADERS }

        // Add auth headers for v4 API endpoint
        if (isV4) {
          const authHeaders = buildAuthHeaders(
            'GET',
            urlObj.pathname,
            urlObj.search.replace(/^\?/, ''),
          )
          if (authHeaders) {
            Object.assign(reqHeaders, authHeaders)
          }
        }

        const data = await fetchJson<GateResponse>(url, { headers: reqHeaders, timeoutMs: 10000 })

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
      } catch (err) {
        logger.warn(`[${SOURCE}] Page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }

    if (allTraders.size > 0) break
  }

  // VPS proxy fallback for CF-protected endpoints
  if (allTraders.size === 0) {
    const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_SG
    if (vpsUrl) {
      logger.warn(`[${SOURCE}] All direct endpoints failed, trying VPS proxy...`)
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
          })
          if (!res.ok) continue
          const data = (await res.json()) as GateResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.user_id || item.uid || item.trader_id || item.id || item.userId || '')
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

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from Gate.io — all endpoints and VPS proxy failed' }
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
