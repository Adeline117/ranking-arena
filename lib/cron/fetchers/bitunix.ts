/**
 * Bitunix Futures — Inline fetcher for Vercel serverless
 *
 * Bitunix copy trading page: https://www.bitunix.com/copy-trading/square
 * API: POST https://api.bitunix.com/copy/trading/v1/trader/list
 * No auth required. Up to 200 traders per page, 3600+ total.
 *
 * Periods: 7D, 30D, 90D
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  sleep,
  parseNum,
  normalizeWinRate,
  getWinRateFormat,
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitunix'
const API_URL = 'https://api.bitunix.com/copy/trading/v1/trader/list'
const TARGET = 2000
const PAGE_SIZE = 200

// statisticType: 1=7D, 2=30D, 3=90D, 4=180D
const PERIOD_MAP: Record<string, number> = {
  '7D': 1,
  '30D': 2,
  '90D': 3,
}

interface BitunixTrader {
  uid?: number | string
  nickname?: string
  header?: string
  roi?: string | number
  pl?: string | number
  mdd?: string | number
  winRate?: string | number
  aum?: string | number
  currentFollow?: number
  maxFollow?: number
}

interface BitunixResponse {
  code: number
  msg: string
  data: {
    records: BitunixTrader[]
    total: number
    totalPage: number
    page: number
  }
}

function parseTrader(item: BitunixTrader, period: string, rank: number): TraderData | null {
  const id = String(item.uid || '')
  if (!id || id === 'undefined') return null

  const roi = parseNum(item.roi)
  if (roi === null) return null

  const pnl = parseNum(item.pl)

  let winRate = parseNum(item.winRate)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.mdd)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.currentFollow)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: item.nickname || `Trader_${id.slice(0, 8)}`,
    profile_url: `https://www.bitunix.com/copy-trading/trader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.header || null,
  }
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const statisticType = PERIOD_MAP[period] ?? 2
  const allTraders: BitunixTrader[] = []
  const totalPages = Math.ceil(TARGET / PAGE_SIZE)

  for (let page = 1; page <= totalPages; page++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          statisticType,
          oderType: 'ROI',
          page,
          pageSize: PAGE_SIZE,
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        if (page === 1) {
          return { total: 0, saved: 0, error: `Bitunix API returned ${res.status}` }
        }
        break
      }

      const data = (await res.json()) as BitunixResponse
      if (data.code !== 0 || !data.data?.records?.length) {
        if (page === 1) {
          return { total: 0, saved: 0, error: `Bitunix API error: ${data.msg || 'no data'}` }
        }
        break
      }

      allTraders.push(...data.data.records)

      if (allTraders.length >= data.data.total || data.data.records.length < PAGE_SIZE) break
    } catch (err) {
      if (page === 1) {
        return { total: 0, saved: 0, error: `Bitunix API failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      break
    }

    if (page < totalPages) await sleep(500)
  }

  if (allTraders.length === 0) {
    return { total: 0, saved: 0, error: 'Bitunix API returned no traders' }
  }

  const traders: TraderData[] = []
  for (let i = 0; i < allTraders.length; i++) {
    const trader = parseTrader(allTraders[i], period, i + 1)
    if (trader) traders.push(trader)
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  return { total: top.length, saved, error }
}

export async function fetchBitunix(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period)
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { platform: SOURCE, period },
      })
      result.periods[period] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
    }
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  result.duration = Date.now() - start
  return result
}
