/**
 * eToro — Inline fetcher for Vercel serverless
 *
 * eToro is the world's largest social trading platform with 3.4M+ traders.
 * Public API at /sapi/rankings/rankings/ — no auth required.
 *
 * API: https://www.etoro.com/sapi/rankings/rankings/?Period=OneMonthAgo&page=1&pagesize=100
 * Fields: Gain (ROI%), WinRatio, Copiers, AUMValue, PeakToValley (MDD), RiskScore, Country
 *
 * Period mapping:
 *   7D  → CurrMonth (no weekly period available, closest match)
 *   30D → OneMonthAgo
 *   90D → ThreeMonthsAgo
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'etoro'
const API_BASE = 'https://www.etoro.com/sapi/rankings/rankings/'
const TARGET = 2000
const PAGE_SIZE = 100

const PERIOD_MAP: Record<string, string> = {
  '7D': 'CurrMonth',
  '30D': 'OneMonthAgo',
  '90D': 'ThreeMonthsAgo',
}

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

// eToro InstrumentTypeID for crypto assets
// Adding this filter to the API request ensures only crypto traders are returned
const CRYPTO_INSTRUMENT_TYPE = 10 // Crypto = 10

interface EtoroTrader {
  CustomerId: number
  UserName: string
  FullName?: string
  HasAvatar?: boolean
  DisplayFullName?: boolean
  Gain: number        // ROI as percentage (-4.22 = -4.22%)
  WinRatio: number    // Win rate as percentage (46.57 = 46.57%)
  Copiers: number     // Number of copiers
  AUMValue?: number   // Assets under management in USD
  PeakToValley: number // Max drawdown as negative percentage (-8.43 = 8.43% drawdown)
  RiskScore: number   // 1-10 risk score
  DailyDD?: number    // Daily drawdown
  WeeklyDD?: number   // Weekly drawdown
  Country?: string
  PopularInvestor?: boolean
  Trades?: number
  ActiveWeeks?: number
  TopTradedInstrumentId?: number
  TopTradedAssetClassName?: string
}

interface EtoroResponse {
  Status: string
  TotalRows: number
  Items: EtoroTrader[]
}

// Known non-crypto asset class names from eToro
const NON_CRYPTO_CLASSES = new Set(['Stocks', 'ETFs', 'Currencies', 'Commodities', 'Indices'])

function parseTrader(item: EtoroTrader, period: string, rank: number): TraderData | null {
  if (!item.CustomerId || !item.UserName) return null

  // Skip non-crypto traders (fallback if API InstrumentTypeID filter is ignored)
  if (item.TopTradedAssetClassName && NON_CRYPTO_CLASSES.has(item.TopTradedAssetClassName)) return null

  const roi = item.Gain // Already in percentage format
  if (roi == null) return null

  // eToro doesn't expose raw PnL, but AUM * gain gives estimate
  const pnl = item.AUMValue && item.Gain
    ? (item.AUMValue * item.Gain) / 100
    : null

  const winRate = item.WinRatio // Already percentage (46.57 = 46.57%)
  const maxDrawdown = item.PeakToValley != null ? Math.abs(item.PeakToValley) : null
  const followers = item.Copiers || null

  const id = String(item.CustomerId)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: item.UserName,
    profile_url: `https://www.etoro.com/people/${item.UserName}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.HasAvatar
      ? `https://etoro-cdn.etorostatic.com/avatars/${item.CustomerId}/150x150.jpg`
      : null,
  }
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const etoroPeriod = PERIOD_MAP[period]
  if (!etoroPeriod) {
    return { total: 0, saved: 0, error: `Unknown period: ${period}` }
  }

  const allTraders: TraderData[] = []
  const totalPages = Math.ceil(TARGET / PAGE_SIZE)

  for (let page = 1; page <= totalPages; page++) {
    // Note: InstrumentTypeID filter was removed due to API 403 errors (2026-03-11)
    // Crypto filtering is handled by TopTradedAssetClassName check in parseTrader()
    const url = `${API_BASE}?Period=${etoroPeriod}&page=${page}&pagesize=${PAGE_SIZE}`

    try {
      const data = await fetchJson<EtoroResponse>(url, {
        headers: HEADERS,
        timeoutMs: 15000,
      })

      if (!data?.Items?.length) {
        if (page === 1) {
          return { total: 0, saved: 0, error: 'eToro API returned no data' }
        }
        break
      }

      for (let i = 0; i < data.Items.length; i++) {
        const rank = (page - 1) * PAGE_SIZE + i + 1
        const trader = parseTrader(data.Items[i], period, rank)
        if (trader) allTraders.push(trader)
      }

      if (data.Items.length < PAGE_SIZE) break
    } catch (err) {
      if (page === 1) {
        return { total: 0, saved: 0, error: `eToro API failed: ${err instanceof Error ? err.message : String(err)}` }
      }
      break // Partial data is fine
    }

    if (page < totalPages) await sleep(500)
  }

  if (allTraders.length === 0) {
    return { total: 0, saved: 0, error: 'eToro: no valid traders parsed' }
  }

  // Sort by ROI descending (API default is by copiers)
  allTraders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = allTraders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  return { total: top.length, saved, error }
}

export async function fetchEtoro(
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
