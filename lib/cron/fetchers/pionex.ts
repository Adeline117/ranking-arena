/**
 * Pionex — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_pionex_v2.mjs (Playwright-based with CF bypass)
 *
 * [WARN] CF-PROTECTED: All API endpoints behind Cloudflare challenge.
 * Endpoints discovered from original script (tried via page.evaluate inside browser):
 * 1. /kol-apis/tapi/v1/kol/list
 * 2. /kol-apis/tapi/v1/future/copy_trading/kol_list
 * 3-6. Various other kol_rank, copy_trading paths
 * All return CF challenge without browser session.
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
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'pionex'
const TARGET = 500
const BASE = 'https://www.pionex.com'

/** Period parameter mapping for Pionex API */
const PERIOD_MAP: Record<string, number> = {
  '7D': 1,
  '30D': 2,
  '90D': 3,
}

const HEADERS: Record<string, string> = {
  Referer: 'https://www.pionex.com/en/copy-trade',
  Origin: 'https://www.pionex.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/** All known Pionex API endpoints with their parameter styles */
const ENDPOINTS = [
  { path: '/kol-apis/tapi/v1/kol/list', params: (p: number, _period: number) => `sort_field=roi&page_num=${p}&page_size=100&sort_type=desc` },
  { path: '/kol-apis/tapi/v1/future/copy_trading/kol_list', params: (p: number, period: number) => `sort_field=roi&page_num=${p}&page_size=100&sort_type=desc&period=${period}` },
  { path: '/kol-apis/tapi/v1/copy_trading_rank_list', params: (p: number, _period: number) => `sort_field=roi&page_num=${p}&page_size=100` },
  { path: '/kol-apis/tapi/v1/future/kol_rank_list', params: (p: number, period: number) => `sort_field=roi&page_num=${p}&page_size=100&period=${period}` },
  { path: '/kol-apis/tapi/v1/copy/trader_list', params: (p: number, _period: number) => `sort=roi&page=${p}&size=100` },
  { path: '/kol-apis/tapi/v1/home_page/recommend_kol', params: () => '' },
]

interface PionexTrader {
  uid?: string
  user_id?: string
  kol_user_id?: string
  traderId?: string
  userId?: string
  id?: string
  nickname?: string
  nick_name?: string
  traderName?: string
  name?: string
  display_name?: string
  avatar?: string
  avatar_url?: string
  headUrl?: string
  roi?: string | number
  roi_rate?: string | number
  roiRate?: string | number
  profit_rate?: string | number
  profitRate?: string | number
  returnRate?: string | number
  pnl?: string | number
  total_pnl?: string | number
  totalPnl?: string | number
  profit?: string | number
  win_rate?: string | number
  winRate?: string | number
  max_drawdown?: string | number
  maxDrawdown?: string | number
  followers?: string | number
  follower_num?: string | number
  copy_num?: string | number
  copyNum?: string | number
}

function parseTrader(item: PionexTrader, period: string, rank: number): TraderData | null {
  const id = String(item.uid || item.user_id || item.kol_user_id || item.traderId || item.userId || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.roi_rate ?? item.roiRate ?? item.profit_rate ?? item.profitRate ?? item.returnRate)
  if (roi === null) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100

  const pnl = parseNum(item.pnl ?? item.total_pnl ?? item.totalPnl ?? item.profit)

  let winRate = parseNum(item.win_rate ?? item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.max_drawdown ?? item.maxDrawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.followers ?? item.follower_num ?? item.copy_num ?? item.copyNum)
  const handle = item.nickname || item.nick_name || item.traderName || item.name || item.display_name || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.pionex.com/copy-trade/trader/${id}`,
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

/**
 * Recursively search for arrays that look like trader data in a JSON response
 */
function findTraderArrays(obj: unknown, depth = 0): PionexTrader[][] {
  if (!obj || typeof obj !== 'object' || depth > 3) return []
  const results: PionexTrader[][] = []

  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
    const keys = Object.keys(obj[0] as Record<string, unknown>).join(',').toLowerCase()
    if (keys.match(/roi|pnl|profit|return|win|trade|copy|kol|follow|nickname|avatar/)) {
      results.push(obj as PionexTrader[])
    }
  }

  if (!Array.isArray(obj)) {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        const keys = Object.keys(val[0] as Record<string, unknown>).join(',').toLowerCase()
        if (keys.match(/roi|pnl|profit|return|win|trade|copy|kol|follow|nickname|avatar/)) {
          results.push(val as PionexTrader[])
        }
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        results.push(...findTraderArrays(val, depth + 1))
      }
    }
  }

  return results
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodNum = PERIOD_MAP[period] || 2
  const allTraders = new Map<string, PionexTrader>()

  // Try each endpoint
  for (const ep of ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    // Paginate each endpoint
    for (let page = 0; page <= 10; page++) {
      try {
        const params = ep.params(page, periodNum)
        const url = `${BASE}${ep.path}${params ? '?' + params : ''}`
        const data = await fetchJson<unknown>(url, { headers: HEADERS, timeoutMs: 10000 })

        // Find trader arrays in the response
        const arrays = findTraderArrays(data)
        if (arrays.length === 0) break

        let newCount = 0
        for (const list of arrays) {
          for (const item of list) {
            const id = String(item.uid || item.user_id || item.kol_user_id || item.traderId || item.userId || item.id || '')
            if (id && id !== 'undefined' && !allTraders.has(id)) {
              allTraders.set(id, item)
              newCount++
            }
          }
        }

        if (newCount === 0) break
        await sleep(300)
      } catch (err) {
        logger.warn(`[${SOURCE}] Pagination error: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from Pionex API endpoints' }
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

export async function fetchPionex(
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
