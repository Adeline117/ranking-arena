/**
 * Bybit Spot Copy Trading — Inline fetcher for Vercel serverless
 * API: https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list
 *
 * Same beehive API as Bybit futures, labelled as bybit_spot.
 * metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
 *
 * [WARN] WAF-BLOCKED from US residential IPs (Akamai "Access Denied").
 * Verified correct endpoint from scripts/import/import_bybit_spot.mjs.
 * Should work from Vercel Japan/Singapore datacenters.
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

const SOURCE = 'bybit_spot'
const API_URL =
  'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_MAP: Record<string, string> = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}

// Helper to fetch with proxy fallback
async function fetchWithProxyFallback<T>(url: string): Promise<T> {
  // Try direct first
  try {
    return await fetchJson<T>(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // If WAF blocked, try proxy
    if (msg.includes('403') || msg.includes('Access Denied')) {
      if (PROXY_URL) {
        const proxyTarget = `${PROXY_URL}?url=${encodeURIComponent(url)}`
        return await fetchJson<T>(proxyTarget)
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePercent(s: unknown): number | null {
  if (s == null) return null
  const str = String(s).replace(/,/g, '')
  const m = str.match(/([+-]?)(\d+(?:\.\d+)?)%?/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return parseFloat(m[2]) * sign
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BybitLeaderDetail {
  leaderUserId?: string
  leaderMark?: string
  nickName?: string
  profilePhoto?: string
  currentFollowerCount?: number | string
  metricValues?: string[]
}

interface BybitApiResponse {
  retCode?: number
  result?: {
    leaderDetails?: BybitLeaderDetail[]
  }
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const duration = PERIOD_MAP[period] || PERIOD_MAP['30D']
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const allTraders = new Map<string, BybitLeaderDetail>()

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    try {
      const url =
        `${API_URL}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}` +
        `&dataDuration=${duration}` +
        `&sortField=LEADER_SORT_FIELD_SORT_ROI`

      let data: BybitApiResponse
      try {
        data = await fetchWithProxyFallback<BybitApiResponse>(url)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('403') || msg.includes('Access Denied')) {
          return { total: 0, saved: 0, error: 'WAF-blocked — proxy fallback failed or not configured' }
        }
        throw err
      }

      const details = data?.result?.leaderDetails || []
      if (details.length === 0) break

      for (const item of details) {
        const id = String(item.leaderUserId || item.leaderMark || '')
        if (!id || allTraders.has(id)) continue
        allTraders.set(id, item)
      }

      if (details.length < PAGE_SIZE || allTraders.size >= TARGET) break
      await sleep(500)
    } catch (err) {
      logger.warn(`[${SOURCE}] Pagination error: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  // Map to TraderData
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const [id, item] of Array.from(allTraders)) {
    const mv = item.metricValues || []
    const roi = parsePercent(mv[0])
    if (roi == null || roi === 0) continue

    const maxDrawdown = parsePercent(mv[1])
    const pnl = parseNum(mv[2])
    const winRate = normalizeWinRate(parsePercent(mv[3]))
    const followers = parseInt(String(item.currentFollowerCount || '0'), 10) || null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `BybitSpot_${id.slice(0, 8)}`,
      profile_url: `https://www.bybit.com/copyTrade/tradeInfo?leaderMark=${id}`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
      followers,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function fetchBybitSpot(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      result.periods[period] = await fetchPeriod(supabase, period)
      if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  result.duration = Date.now() - start
  return result
}
