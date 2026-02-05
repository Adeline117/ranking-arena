/**
 * Binance Futures Copy Trading — Inline fetcher for Vercel serverless
 * API: POST https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list
 *
 * Converted from app/api/cron/fetch-traders/binance-inline/route.ts
 * ROI from API is a decimal (e.g. 0.5 = 50%), converted to percentage.
 *
 * ⚠️  GEO-BLOCKED from US IPs (HTTP 451).
 * Works correctly from Vercel Japan/Singapore datacenters.
 * Verified against working app/api/cron/fetch-traders/binance-inline/route.ts
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

const SOURCE = 'binance_futures'
const API_URL =
  'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
const TARGET = 500
const PAGE_SIZE = 20

const PERIOD_MAP: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: 'https://www.binance.com',
  Referer: 'https://www.binance.com/en/copy-trading',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BinanceTrader {
  portfolioId?: string
  leadPortfolioId?: string
  nickName?: string
  roi?: string | number
  pnl?: string | number
  winRate?: string | number
  maxDrawdown?: string | number
  mdd?: string | number
  followerCount?: number
  currentCopyCount?: number
  tradeCount?: number
  userPhotoUrl?: string
}

interface BinanceApiResponse {
  code?: string
  msg?: string
  message?: string
  data?: {
    list?: BinanceTrader[]
  }
  success?: boolean
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const timeRange = PERIOD_MAP[period] || 90
  const maxPages = Math.ceil(TARGET / PAGE_SIZE) + 1
  const allTraders: BinanceTrader[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= maxPages; page++) {
    try {
      const body = {
        pageNumber: page,
        pageSize: PAGE_SIZE,
        timeRange,
        dataType: 'ROI',
        favoriteOnly: false,
        hideFull: false,
        nickname: '',
        order: 'DESC',
      }

      let data: BinanceApiResponse
      try {
        data = await fetchJson<BinanceApiResponse>(API_URL, {
          method: 'POST',
          headers: HEADERS,
          body,
        })
      } catch (err) {
        // Binance returns HTTP 451 for geo-blocked requests
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('451')) {
          return { total: 0, saved: 0, error: 'Geo-blocked (HTTP 451) — deploy to Vercel Japan/SG' }
        }
        throw err
      }

      // Binance may return HTTP 200 with geo-block message in JSON body
      const errMsg = data?.msg || data?.message || ''
      if (errMsg.includes('restricted location') || errMsg.includes('unavailable')) {
        return { total: 0, saved: 0, error: `Geo-blocked: ${errMsg}` }
      }

      // Check for API success status
      if (data?.success === false || (data?.code && data.code !== '000000')) {
        return { total: 0, saved: 0, error: `Binance API error: code=${data?.code}, msg=${errMsg}` }
      }

      const list = data?.data?.list || []
      if (list.length === 0) {
        // First page empty = no data or blocked
        if (page === 1) {
          return { total: 0, saved: 0, error: `No data returned (page 1 empty). Response: ${JSON.stringify(data).slice(0, 200)}` }
        }
        break
      }

      for (const t of list) {
        const id = t.portfolioId || t.leadPortfolioId || ''
        if (!id || seen.has(id)) continue
        seen.add(id)
        allTraders.push(t)
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

  for (const t of allTraders) {
    const id = t.portfolioId || t.leadPortfolioId || ''
    const roiRaw = parseNum(t.roi)
    if (roiRaw == null) continue

    // Binance API returns ROI as decimal: 0.5 = 50%
    const roi = roiRaw * 100
    const pnl = parseNum(t.pnl)
    const wrRaw = parseNum(t.winRate)
    const winRate = normalizeWinRate(wrRaw != null ? (wrRaw <= 1 ? wrRaw * 100 : wrRaw) : null)
    const mddRaw = parseNum(t.maxDrawdown ?? t.mdd)
    const maxDrawdown = mddRaw != null ? Math.abs(mddRaw) : null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: t.nickName || id,
      profile_url: `https://www.binance.com/en/copy-trading/lead-details/${id}`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: t.followerCount || t.currentCopyCount || null,
      trades_count: t.tradeCount || null,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function fetchBinanceFutures(
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
