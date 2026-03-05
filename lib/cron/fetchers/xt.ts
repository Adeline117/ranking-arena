/**
 * XT — Inline fetcher for Vercel serverless
 * API: https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2
 * Original: scripts/import/import_xt.mjs (Playwright + Chrome CDP)
 *
 * Endpoints discovered from the original script:
 * 1. elite-leader-list-v2 (primary, paginated, with sort + days params)
 * 2. leader-list (fallback, simpler pagination)
 * 3. elite-leader-list (fallback)
 *
 * Field mapping: accountId→id, incomeRate→roi, income→pnl, winRate→wr, maxRetraction→dd
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
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'xt'
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

const SORT_TYPES = ['INCOME_RATE', 'FOLLOWER_COUNT', 'INCOME', 'FOLLOWER_PROFIT']

const HEADERS: Record<string, string> = {
  Referer: 'https://www.xt.com/en/copy-trading/futures',
  Origin: 'https://www.xt.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

interface XtTrader {
  accountId?: string | number
  nickName?: string
  avatar?: string
  incomeRate?: string | number
  income?: string | number
  winRate?: string | number
  maxRetraction?: string | number
  followerCount?: string | number
  tradeDays?: number
  followerProfit?: string | number
  totalFollowerProfit?: string | number
  followerMargin?: string | number
  totalFollowerMargin?: string | number
  followNumber?: number
  newFollowNumber?: number
  level?: number
  levelName?: string
}

interface XtGroupResult {
  sotType?: string
  hasMore?: boolean
  items?: XtTrader[]
}

interface XtResponse {
  returnCode?: number
  result?: XtGroupResult[] | { list?: XtTrader[]; items?: XtTrader[]; hasMore?: boolean }
  _err?: string
}

function parseTrader(item: XtTrader, period: string, rank: number): TraderData | null {
  const id = String(item.accountId || '')
  if (!id) return null

  // incomeRate is decimal: 1.0852 = 108.52%
  let roi = parseNum(item.incomeRate)
  if (roi === null) return null
  roi *= 100

  const pnl = parseNum(item.income)

  let winRate = parseNum(item.winRate)
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxRetraction)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: item.nickName || id,
    profile_url: `https://www.xt.com/en/copy-trading/futures/detail/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar || null,
  }
}

/**
 * Fetch from the elite-leader-list-v2 endpoint (primary)
 * This endpoint returns grouped results by sort type
 */
async function fetchEliteV2(
  days: number,
  allTraders: Map<string, XtTrader>
): Promise<void> {
  for (const sortType of SORT_TYPES) {
    let pageNo = 1
    let emptyStreak = 0

    while (pageNo <= 50 && emptyStreak < 2) {
      try {
        const url = `https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list-v2?size=${PAGE_SIZE}&days=${days}&sotType=${sortType}&pageNo=${pageNo}`
        const data = await fetchJson<XtResponse>(url, { headers: HEADERS })

        if (!data || data.returnCode !== 0) break

        let items: XtTrader[] = []
        let hasMore = false

        // Response can be grouped format: [{sotType, hasMore, items}]
        if (Array.isArray(data.result)) {
          for (const group of data.result as XtGroupResult[]) {
            if (group.items) items.push(...group.items)
            if (group.hasMore) hasMore = true
          }
        } else if (data.result && typeof data.result === 'object') {
          const r = data.result as { list?: XtTrader[]; items?: XtTrader[]; hasMore?: boolean }
          items = r.list || r.items || []
          hasMore = r.hasMore !== false
        }

        if (items.length === 0) {
          emptyStreak++
          break
        }

        let newCount = 0
        for (const item of items) {
          const id = String(item.accountId || '')
          if (id && !allTraders.has(id)) {
            allTraders.set(id, item)
            newCount++
          }
        }

        if (newCount === 0) emptyStreak++
        else emptyStreak = 0

        if (!hasMore || items.length < PAGE_SIZE) break
        pageNo++
        await sleep(300)
      } catch {
        break
      }
    }

    if (allTraders.size >= TARGET) break
  }
}

/**
 * Fetch from fallback endpoints: leader-list and elite-leader-list
 */
async function fetchFallbackEndpoints(allTraders: Map<string, XtTrader>): Promise<void> {
  const fallbackUrls = [
    'https://www.xt.com/fapi/user/v1/public/copy-trade/leader-list',
    'https://www.xt.com/fapi/user/v1/public/copy-trade/elite-leader-list',
  ]

  for (const baseUrl of fallbackUrls) {
    for (let pageNo = 1; pageNo <= 100; pageNo++) {
      try {
        const url = `${baseUrl}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}`
        const data = await fetchJson<XtResponse>(url, { headers: HEADERS })

        if (!data || data.returnCode !== 0) break

        let items: XtTrader[] = []
        if (Array.isArray(data.result)) {
          for (const g of data.result as XtGroupResult[]) {
            if (g.items) items.push(...g.items)
          }
        } else if (data.result && typeof data.result === 'object') {
          const r = data.result as { list?: XtTrader[]; items?: XtTrader[] }
          items = r.list || r.items || []
        }

        if (items.length === 0) break

        let newCount = 0
        for (const item of items) {
          const id = String(item.accountId || '')
          if (id && !allTraders.has(id)) {
            allTraders.set(id, item)
            newCount++
          }
        }

        if (newCount === 0) break
        await sleep(300)
      } catch {
        break
      }
    }
  }
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const days = PERIOD_DAYS[period] || 30
  const allTraders = new Map<string, XtTrader>()

  // Primary: elite-leader-list-v2 with different sort types and days
  try {
    await fetchEliteV2(days, allTraders)
  } catch {
    // continue to fallback
  }

  // Fallback: try other endpoints if we didn't get enough
  if (allTraders.size < TARGET) {
    try {
      await fetchFallbackEndpoints(allTraders)
    } catch {
      // ignore
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from XT API endpoints' }
  }

  // Parse and deduplicate
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

  // Build a lookup from parsed traders back to raw data for extra fields
  const rawLookup = new Map<string, XtTrader>()
  for (const [, item] of Array.from(allTraders)) {
    const id = String(item.accountId || '')
    if (id) rawLookup.set(id, item)
  }

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    console.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
    let statsSaved = 0
    for (const trader of top.slice(0, 50)) {
      const raw = rawLookup.get(trader.source_trader_id)
      const copiersPnl = raw ? parseNum(raw.totalFollowerProfit) : null
      const aumVal = raw ? parseNum(raw.totalFollowerMargin) : null
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
        copiersPnl: copiersPnl,
        aum: aumVal && aumVal > 0 ? aumVal : null,
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

export async function fetchXt(
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
