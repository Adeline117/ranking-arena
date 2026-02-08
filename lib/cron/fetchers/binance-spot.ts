/**
 * Binance Spot Copy Trading — Inline fetcher for Vercel serverless
 * API: POST https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list
 *
 * ROI from API is already in percentage form (e.g. 50 = 50%).
 * winRate is 0-100, normalised at save time.
 * timeRange is a string: '7D', '30D', '90D'.
 *
 * [WARN] GEO-BLOCKED from US IPs (HTTP 451).
 * Works correctly from Vercel Japan/Singapore datacenters.
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

const SOURCE = 'binance_spot'
const API_URL =
  'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list'
const TARGET = 500
const PAGE_SIZE = 100

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: 'https://www.binance.com',
  Referer: 'https://www.binance.com/en/copy-trading/spot',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BinanceSpotTrader {
  leadPortfolioId?: string
  portfolioId?: string
  encryptedUid?: string
  nickname?: string
  nickName?: string
  displayName?: string
  roi?: number | string
  pnl?: number | string
  profit?: number | string
  winRate?: number | string
  mdd?: number | string
  maxDrawdown?: number | string
  currentCopyCount?: number
  copierCount?: number
  followerCount?: number
  avatarUrl?: string
  avatar?: string
  userPhoto?: string
  aum?: number | string
}

interface ApiResponse {
  code?: string
  msg?: string
  message?: string
  data?: {
    list?: BinanceSpotTrader[]
    data?: BinanceSpotTrader[]
  }
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const maxPages = Math.ceil(TARGET / PAGE_SIZE) + 1
  const seen = new Set<string>()
  const allTraders: BinanceSpotTrader[] = []

  for (let page = 1; page <= maxPages; page++) {
    try {
      const body = {
        pageNumber: page,
        pageSize: PAGE_SIZE,
        timeRange: period,          // '7D' / '30D' / '90D'
        dataType: 'ROI',
        order: 'DESC',
        portfolioType: 'ALL',
        favoriteOnly: false,
        hideFull: false,
      }

      let data: ApiResponse
      try {
        data = await fetchJson<ApiResponse>(API_URL, {
          method: 'POST',
          headers: HEADERS,
          body,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('451')) {
          return { total: 0, saved: 0, error: 'Geo-blocked (HTTP 451) — deploy to Vercel Japan/SG' }
        }
        throw err
      }

      const list = data?.data?.list || data?.data?.data || []
      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list) {
        const id = String(
          item.leadPortfolioId || item.portfolioId || item.encryptedUid || ''
        )
        if (!id || seen.has(id)) continue
        seen.add(id)
        allTraders.push(item)
      }

      if (allTraders.length >= TARGET) break
      await sleep(500)
    } catch {
      break
    }
  }

  // Map to TraderData
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const item of allTraders) {
    const id = String(
      item.leadPortfolioId || item.portfolioId || item.encryptedUid || ''
    )
    // ROI is already in percentage form
    const roi = parseNum(item.roi)
    if (roi == null) continue

    const pnl = parseNum(item.pnl ?? item.profit)
    const wrRaw = parseNum(item.winRate)
    // winRate from API is 0-100; normalizeWinRate handles <=1 → *100
    const winRate = normalizeWinRate(wrRaw != null ? (wrRaw > 1 ? wrRaw : wrRaw * 100) : null)
    const mddRaw = parseNum(item.mdd ?? item.maxDrawdown)
    const maxDrawdown = mddRaw != null ? Math.abs(mddRaw) : null
    const followers =
      item.currentCopyCount || item.copierCount || item.followerCount || null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickname || item.nickName || item.displayName || id,
      profile_url: `https://www.binance.com/en/copy-trading/lead-details/${id}?type=spot`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
      avatar_url: item.avatarUrl || item.avatar || item.userPhoto || null,
    })
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

export async function fetchBinanceSpot(
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
