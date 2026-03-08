/**
 * Bybit Spot Copy Trading — Inline fetcher for Vercel serverless
 * API: https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
 *
 * Same beehive API as Bybit futures, labelled as bybit_spot.
 * metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
 *
 * Uses api2.bybit.com to bypass Akamai WAF on www.bybit.com.
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
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bybit_spot'
// api2.bybit.com bypasses Akamai WAF that blocks www.bybit.com/x-api
const API_URL =
  'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
// VPS Playwright scraper: uses bybitglobal.com + browser to bypass Akamai WAF
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''
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
// Batch prefetch: all periods in single VPS browser session (~55s vs ~195s)
// ---------------------------------------------------------------------------

const _batchCache = new Map<string, BybitApiResponse>()

async function prefetchBatch(periods: string[]): Promise<void> {
  if (!VPS_SCRAPER_KEY) return
  const durations = periods.map(p => PERIOD_MAP[p] || PERIOD_MAP['30D'])
  try {
    const url = `${VPS_SCRAPER_URL}/bybit/leaderboard-batch?pageSize=${PAGE_SIZE}&durations=${durations.join(',')}`
    const res = await fetch(url, {
      headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
      signal: AbortSignal.timeout(120_000),
    })
    if (res.ok) {
      const data = await res.json() as Record<string, BybitApiResponse>
      for (const [dur, resp] of Object.entries(data)) {
        if (resp?.result?.leaderDetails && resp.result.leaderDetails.length > 0) {
          _batchCache.set(dur, resp)
        }
      }
      logger.info(`[${SOURCE}] Batch prefetch: ${_batchCache.size}/${durations.length} periods cached`)
    }
  } catch (err) {
    logger.warn(`[${SOURCE}] Batch prefetch failed: ${err instanceof Error ? err.message : err}`)
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
    let data: BybitApiResponse | null = null

    // Strategy 0: Check batch cache (prefetched all periods in single browser session)
    if (pageNo === 1 && _batchCache.has(duration)) {
      data = _batchCache.get(duration)!
      _batchCache.delete(duration)
      logger.info(`[${SOURCE}] Using batch-cached data for ${duration}`)
    }

    // Strategy 1: VPS Playwright scraper (bypasses Akamai WAF)
    // Only page 1, only if batch cache missed
    if (!data && VPS_SCRAPER_KEY && pageNo <= 1 && _batchCache.size === 0) {
      try {
        const scraperUrl = `${VPS_SCRAPER_URL}/bybit/leaderboard?pageNo=${pageNo}&pageSize=${PAGE_SIZE}&duration=${duration}`
        const res = await fetch(scraperUrl, {
          headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
          signal: AbortSignal.timeout(240_000),
        })
        if (res.ok) {
          const scraperData = (await res.json()) as BybitApiResponse
          if (scraperData?.result?.leaderDetails?.length) {
            data = scraperData
          }
        }
      } catch (err) {
        logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Strategy 2: Direct API + proxy fallback
    if (!data) {
      try {
        const url =
          `${API_URL}?pageNo=${pageNo}&pageSize=${PAGE_SIZE}` +
          `&dataDuration=${duration}` +
          `&sortField=LEADER_SORT_FIELD_SORT_ROI`
        data = await fetchWithProxyFallback<BybitApiResponse>(url)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('403') || msg.includes('Access Denied')) {
          if (allTraders.size === 0) {
            return { total: 0, saved: 0, error: 'WAF-blocked — all strategies failed' }
          }
          break
        }
        logger.warn(`[${SOURCE}] Page fetch failed: ${msg}`)
        break
      }
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
    const winRate = normalizeWinRate(parsePercent(mv[3]), getWinRateFormat(SOURCE))
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
    // Prefetch all periods in a single VPS browser session (~55s vs ~195s)
    await prefetchBatch(periods)

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
