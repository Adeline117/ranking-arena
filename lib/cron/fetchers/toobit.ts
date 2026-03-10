/**
 * Toobit — Inline fetcher for Vercel serverless
 *
 * Toobit copy trading page: https://www.toobit.com/copytrading
 * Ranking page: https://www.toobit.com/copytrading/ranking
 *
 * API endpoints (discovered 2026-03-10):
 *   - bapi.toobit.com/bapi/v1/copy-trading/ranking?page=1&dataType={7|30|90}&kind={0-4}
 *     Returns: { code: 200, data: { list: [...], total, pages } }
 *     Fields: leaderUserId, name, avatar, profitRatio (ROI as ratio), profit (PnL USDT),
 *             followerTotal, maxFollowerCount, followerProfit, rank, level, status
 *     kind: 0=ROI, 1=PnL, 2=follower profit, 3=followers, 4=AUM
 *     NOTE: Pagination broken — always returns page 1 (20 items). Use all kinds for ~70 unique.
 *
 *   - bapi.toobit.com/bapi/v1/copy-trading/identity-type-leaders?dataType={7|30|90}
 *     Returns: { code: 200, data: { topProfitRate: [...], topProfit: [...], ... } }
 *     Fields: leaderUserId, nickname, avatar, leaderAvgProfitRatio, pnl, followTotalProfit,
 *             currentFollowerCount, maxLeadCount, leaderProfitOrderRatio, sharpeRatio
 *
 * Strategy order:
 * 1. VPS scraper (primary — aggregates from ranking API kinds + identity-type-leaders, ~70 traders)
 * 2. Direct bapi.toobit.com API (fallback — no WAF, works from any IP)
 *
 * VPS scraper deployed at /opt/scraper/server.js on SG VPS (2026-03-10, v15):
 *   Endpoint: GET /toobit/leaderboard?period=30&pageSize=50
 *   No Playwright needed — uses direct API calls to bapi.toobit.com
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
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'toobit'
const TARGET = 500
const PAGE_SIZE = 50
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

const PERIOD_MAP: Record<string, string> = {
  '7D': '7',
  '30D': '30',
  '90D': '90',
}

const HEADERS: Record<string, string> = {
  Referer: 'https://www.toobit.com/copytrading/ranking',
  Origin: 'https://www.toobit.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
}

// Ranking API kinds: 0=ROI, 1=PnL, 2=follower profit, 3=followers, 4=AUM
const RANKING_KINDS = [0, 1, 2, 3, 4]

interface ToobitTrader {
  // ID fields (ranking API uses leaderUserId)
  leaderUserId?: string
  leaderId?: string
  uid?: string
  userId?: string
  id?: string | number
  // Name fields (ranking API uses name, identity-type uses nickname)
  name?: string
  nickname?: string
  nickName?: string
  displayName?: string
  // Avatar
  avatar?: string
  avatarUrl?: string
  // ROI (ranking API: profitRatio as decimal ratio e.g. 2.7061 = 270.61%)
  profitRatio?: number | string
  leaderAvgProfitRatio?: number | string
  roi?: number | string
  returnRate?: number | string
  // PnL (ranking API: profit in USDT, identity-type: pnl)
  profit?: number | string
  pnl?: number | string
  // Win rate (identity-type-leaders: leaderProfitOrderRatio)
  leaderProfitOrderRatio?: number | string
  winRate?: number | string
  win_rate?: number | string
  // Drawdown
  maxDrawdown?: number | string
  max_drawdown?: number | string
  // Followers (ranking API: followerTotal)
  followerTotal?: number | string
  followers?: number | string
  followerCount?: number | string
  maxFollowerCount?: number | string
  currentFollowerCount?: number | string
  copiers?: number | string
  copyCount?: number | string
  // Extra
  sharpeRatio?: number | string
  rank?: number
}

interface ToobitResponse {
  code?: number | string
  data?: {
    list?: ToobitTrader[]
    rows?: ToobitTrader[]
    records?: ToobitTrader[]
    total?: number
  } | ToobitTrader[]
  msg?: string
}

function parseTrader(item: ToobitTrader, period: string, rank: number): TraderData | null {
  const id = String(item.leaderUserId || item.leaderId || item.uid || item.userId || item.id || '')
  if (!id || id === 'undefined') return null

  // ROI: profitRatio is a decimal ratio (e.g. 2.7061 = 270.61%)
  // leaderAvgProfitRatio from identity-type-leaders is also a ratio
  let roi = parseNum(item.profitRatio ?? item.leaderAvgProfitRatio ?? item.roi ?? item.returnRate)
  if (roi === null) return null
  // Convert ratio to percentage (API returns e.g. 2.7061 meaning 270.61%)
  roi = roi * 100

  const pnl = parseNum(item.profit ?? item.pnl)
  // leaderProfitOrderRatio from identity-type-leaders is win rate as ratio (0-1)
  const rawWinRate = parseNum(item.leaderProfitOrderRatio ?? item.winRate ?? item.win_rate)
  const winRate = normalizeWinRate(rawWinRate, getWinRateFormat(SOURCE))
  let maxDrawdown = parseNum(item.maxDrawdown ?? item.max_drawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) maxDrawdown *= 100

  const followers = parseNum(item.followerTotal ?? item.currentFollowerCount ?? item.followers ?? item.followerCount ?? item.copiers ?? item.copyCount)
  const handle = item.name || item.nickname || item.nickName || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    avatar_url: item.avatar || item.avatarUrl || null,
    profile_url: `https://www.toobit.com/copytrading/trader/info?id=${id}`,
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

function extractList(data: ToobitResponse): ToobitTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as { list?: ToobitTrader[]; rows?: ToobitTrader[]; records?: ToobitTrader[] }
    return d.list || d.rows || d.records || []
  }
  return []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30'
  const allTraders = new Map<string, ToobitTrader>()

  // Strategy 1: VPS scraper (primary — aggregates ranking API kinds + identity-type-leaders)
  if (VPS_SCRAPER_KEY) {
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/toobit/leaderboard?period=${periodStr}&pageSize=${PAGE_SIZE}`
      logger.warn(`[${SOURCE}] Trying VPS scraper...`)
      const res = await fetch(scraperUrl, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) {
        const data = (await res.json()) as ToobitResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.leaderUserId || item.leaderId || item.uid || item.userId || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) allTraders.set(id, item)
        }
        if (allTraders.size > 0) {
          logger.info(`[${SOURCE}] VPS scraper got ${allTraders.size} traders`)
        }
      } else {
        logger.warn(`[${SOURCE}] VPS scraper HTTP ${res.status}`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Strategy 2: Direct bapi.toobit.com API (fallback — no WAF, works from any IP)
  if (allTraders.size === 0) {
    for (const kind of RANKING_KINDS) {
      try {
        const url = `https://bapi.toobit.com/bapi/v1/copy-trading/ranking?page=1&dataType=${periodStr}&kind=${kind}`
        const data = await fetchJson<ToobitResponse>(url, { headers: HEADERS, timeoutMs: 10000 })
        const list = extractList(data)
        let newCount = 0
        for (const item of list) {
          const id = String(item.leaderUserId || item.leaderId || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) {
            allTraders.set(id, item)
            newCount++
          }
        }
        if (newCount > 0) logger.info(`[${SOURCE}] Direct API kind=${kind}: ${newCount} new traders`)
      } catch (err) {
        logger.warn(`[${SOURCE}] Direct API kind=${kind} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Also try identity-type-leaders for extra traders
    try {
      const url = `https://bapi.toobit.com/bapi/v1/copy-trading/identity-type-leaders?dataType=${periodStr}`
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) })
      if (res.ok) {
        const json = await res.json() as { code?: number; data?: Record<string, ToobitTrader[]> }
        if (json.data && typeof json.data === 'object') {
          let newCount = 0
          for (const key of Object.keys(json.data)) {
            const items = json.data[key]
            if (!Array.isArray(items)) continue
            for (const item of items) {
              const id = String(item.leaderUserId || '')
              if (id && !allTraders.has(id)) {
                allTraders.set(id, item)
                newCount++
              }
            }
          }
          if (newCount > 0) logger.info(`[${SOURCE}] identity-type-leaders: ${newCount} new traders`)
        }
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] identity-type-leaders failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from Toobit API endpoints — may need browser scraping' }
  }

  const traders: TraderData[] = []
  let rank = 0
  for (const [, item] of Array.from(allTraders)) {
    rank++
    const trader = parseTrader(item, period, rank)
    if (trader && trader.roi !== null && trader.roi !== 0) traders.push(trader)
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

export async function fetchToobit(
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
