/**
 * BTCC — Inline fetcher for Vercel serverless
 *
 * BTCC copy trading page: https://www.btcc.com/en-US/copy-trading
 * API endpoint: POST https://www.btcc.com/documentary/trader/page
 *
 * No auth required. ~1,750 traders available.
 * sortType: 1=overall, 2=total PnL, 3=copied order size, 4=PnL%, 5=win rate
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
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'btcc'
const TARGET = 1000
const PAGE_SIZE = 50

const API_URL = 'https://www.btcc.com/documentary/trader/page'

const HEADERS: Record<string, string> = {
  Referer: 'https://www.btcc.com/en-US/copy-trading',
  Origin: 'https://www.btcc.com',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

interface BtccTrader {
  traderId?: string | number
  nickName?: string
  avatarPic?: string
  totalNetProfit?: number | string
  rateProfit?: number | string
  winRate?: number | string
  maxBackRate?: number | string
  followNum?: number | string
  limitFollow?: number | string
}

interface BtccResponse {
  code?: number | string
  data?: {
    list?: BtccTrader[]
    records?: BtccTrader[]
    total?: number
    totalPage?: number
    pages?: number
  } | null
  rows?: BtccTrader[]
  total?: number
  msg?: string
  message?: string
}

function parseTrader(item: BtccTrader, period: string, rank: number): TraderData | null {
  const id = String(item.traderId || '')
  if (!id || id === 'undefined') return null

  // ROI is in percentage format (27.5 = 27.5%)
  let roi = parseNum(item.rateProfit)
  if (roi === null) return null
  roi = normalizeROI(roi, SOURCE) ?? roi

  // PnL in USDT
  const pnl = parseNum(item.totalNetProfit)

  // Win rate is in percentage format (65.5 = 65.5%)
  const winRate = normalizeWinRate(parseNum(item.winRate), getWinRateFormat(SOURCE))

  // Max drawdown is in basis points (789.0 = 7.89%), convert to percentage
  let maxDrawdown = parseNum(item.maxBackRate)
  if (maxDrawdown !== null) maxDrawdown = maxDrawdown / 100

  const followers = parseNum(item.followNum)
  const handle = item.nickName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    avatar_url: item.avatarPic || null,
    profile_url: `https://www.btcc.com/en-US/copy-trading/trader/${id}`,
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

function extractList(data: BtccResponse): BtccTrader[] {
  if (!data) return []
  // New format: traders in top-level `rows` array (data is null)
  if (Array.isArray(data.rows) && data.rows.length > 0) {
    return data.rows
  }
  // Legacy format: traders nested in data.list or data.records
  if (data.data && typeof data.data === 'object') {
    return data.data.list || data.data.records || []
  }
  return []
}

async function fetchAllTraders(): Promise<Map<string, BtccTrader>> {
  const allTraders = new Map<string, BtccTrader>()
  let consecutiveEmpty = 0

  for (let page = 1; page <= Math.ceil(TARGET / PAGE_SIZE); page++) {
    try {
      const data = await fetchJson<BtccResponse>(API_URL, {
        method: 'POST',
        headers: HEADERS,
        body: {
          pageNum: page,
          pageSize: PAGE_SIZE,
          sortType: 4, // PnL% (ROI ranking)
          nickName: '',
        },
        timeoutMs: 10000,
      })

      const list = extractList(data)

      if (list.length === 0) {
        consecutiveEmpty++
        if (consecutiveEmpty >= 2) break
        continue
      }

      consecutiveEmpty = 0

      for (const item of list) {
        const id = String(item.traderId || '')
        if (id && id !== 'undefined' && !allTraders.has(id)) {
          allTraders.set(id, item)
        }
      }

      if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
      await sleep(300)
    } catch (err) {
      logger.warn(`[${SOURCE}] Page ${page} fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  return allTraders
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string,
  sharedTraders: Map<string, BtccTrader>
): Promise<{ total: number; saved: number; error?: string }> {
  if (sharedTraders.size === 0) {
    return { total: 0, saved: 0, error: 'No data from BTCC API' }
  }

  const traders: TraderData[] = []
  let rank = 0
  for (const [, item] of Array.from(sharedTraders)) {
    rank++
    const trader = parseTrader(item, period, rank)
    if (trader && trader.roi !== null && trader.roi !== 0) traders.push(trader)
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

export async function fetchBtcc(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    // Fetch all traders once (API doesn't have period filter)
    const sharedTraders = await fetchAllTraders()

    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period, sharedTraders)
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
