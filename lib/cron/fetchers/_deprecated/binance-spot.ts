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
  getWinRateFormat,
} from '../shared'
import { type StatsDetail, upsertStatsDetail } from '../enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'binance_spot'
const API_URL =
  'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list'
const DETAIL_API_URL =
  'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/common/portfolio-detail'
const _PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const TARGET = 500
const PAGE_SIZE = 100
const ENRICH_LIMIT = 300
const ENRICH_CONCURRENCY = 5
const ENRICH_DELAY_MS = 500

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: 'https://www.binance.com',
  Referer: 'https://www.binance.com/en/copy-trading/spot',
}

// Strategy cache: once we find a working method, reuse it
let _cachedStrategy: 'direct' | 'vps' | null = null

async function fetchViaVps<T>(vpsUrl: string, targetUrl: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<T> {
  const res = await fetch(vpsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
    },
    body: JSON.stringify({
      url: targetUrl,
      method: opts.method || 'POST',
      headers: opts.headers || {},
      body: opts.body || null,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`VPS proxy HTTP ${res.status}`)
  return (await res.json()) as T
}

// Helper to fetch with proxy fallback (direct → VPS proxy)
// Falls back on geo-block (451/403) AND timeouts — Vercel hnd1 often times out to Binance
async function fetchWithProxyFallback<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }
): Promise<T> {
  const vpsUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP

  // If we already know VPS works, skip direct
  if (_cachedStrategy === 'vps' && vpsUrl) {
    return await fetchViaVps<T>(vpsUrl, url, opts)
  }

  // If no VPS configured, go direct only
  if (!vpsUrl) {
    const result = await fetchJson<T>(url, { ...opts, timeoutMs: opts?.timeoutMs || 10000 })
    _cachedStrategy = 'direct'
    return result
  }

  // Try direct first (short timeout since we have VPS fallback)
  try {
    const result = await fetchJson<T>(url, { ...opts, timeoutMs: opts?.timeoutMs || 8000 })
    _cachedStrategy = 'direct'
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    const isBlocked = msg.includes('451') || msg.includes('403') || msg.includes('Access Denied') || msg.includes('geo-blocked')
    const isTimeout = msg.includes('abort') || msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')

    // Only fallback for blockable/timeout errors
    if (!isBlocked && !isTimeout) throw err

    // Direct failed (geo-blocked or timeout) → try VPS proxy
    try {
      logger.warn(`[binance-spot] Direct failed (${isBlocked ? 'geo-blocked' : 'timeout'}), switching to VPS proxy`)
      const result = await fetchViaVps<T>(vpsUrl, url, opts)
      _cachedStrategy = 'vps'
      return result
    } catch (vpsErr) {
      logger.warn(`[binance-spot] VPS proxy also failed: ${vpsErr instanceof Error ? vpsErr.message : String(vpsErr)}`)
    }

    throw new Error(
      `Direct ${isBlocked ? 'geo-blocked' : 'timed out'} and VPS proxy failed. ` +
      `Direct: ${msg}`)
  }
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
// Detail API enrichment (fetches winRate for traders missing it)
// ---------------------------------------------------------------------------

const PERIOD_TO_TIMERANGE: Record<string, string> = {
  '7D': 'WEEKLY',
  '30D': 'MONTHLY',
  '90D': 'QUARTERLY',
}

interface DetailResponse {
  data?: {
    winRate?: number | string
    maxDrawdown?: number | string
    mdd?: number | string
    copierCount?: number | string
    followerCount?: number | string
    currentCopyCount?: number | string
  }
}

async function enrichTraderDetail(
  traderId: string,
  period: string
): Promise<{ winRate: number | null; maxDrawdown: number | null; followers: number | null }> {
  try {
    const timeRange = PERIOD_TO_TIMERANGE[period] || 'QUARTERLY'
    const data = await fetchWithProxyFallback<DetailResponse>(DETAIL_API_URL, {
      method: 'POST',
      headers: HEADERS,
      body: { portfolioId: traderId, timeRange },
      timeoutMs: 8000,
    })

    const d = data?.data
    if (!d) return { winRate: null, maxDrawdown: null, followers: null }

    let winRate = parseNum(d.winRate)
    // Detail API returns winRate as decimal 0-1
    winRate = normalizeWinRate(winRate, 'decimal')

    let maxDrawdown = parseNum(d.maxDrawdown ?? d.mdd)
    if (maxDrawdown != null) maxDrawdown = Math.abs(maxDrawdown)
    // Detail API returns as decimal
    if (maxDrawdown != null && maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100

    const followers = parseNum(d.copierCount ?? d.followerCount ?? d.currentCopyCount)

    return { winRate, maxDrawdown, followers: followers != null ? Math.round(followers) : null }
  } catch (err) {
    logger.warn(`[${SOURCE}] enrichTraderDetail failed: ${err instanceof Error ? err.message : String(err)}`)
    return { winRate: null, maxDrawdown: null, followers: null }
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
        data = await fetchWithProxyFallback<ApiResponse>(API_URL, {
          method: 'POST',
          headers: HEADERS,
          body,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('451') || msg.includes('403')) {
          return { total: 0, saved: 0, error: 'Geo-blocked (HTTP 451/403) — proxy fallback failed or not configured' }
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
    } catch (err) {
      logger.warn(`[${SOURCE}] Page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
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
    const winRate = normalizeWinRate(wrRaw, getWinRateFormat(SOURCE))
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

  // Enrich traders missing win_rate via detail API
  const toEnrich = top.filter(t => t.win_rate == null).slice(0, ENRICH_LIMIT)
  if (toEnrich.length > 0) {
    logger.warn(`[${SOURCE}] Enriching ${toEnrich.length} traders with detail API for win_rate...`)
    let enriched = 0
    for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
      const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY)
      await Promise.all(
        batch.map(async (trader) => {
          const detail = await enrichTraderDetail(trader.source_trader_id, period)
          if (detail.winRate != null) { trader.win_rate = detail.winRate; enriched++ }
          if (detail.maxDrawdown != null && trader.max_drawdown == null) trader.max_drawdown = detail.maxDrawdown
          if (detail.followers != null && trader.followers == null) trader.followers = detail.followers
          // Recalculate arena score with enriched data
          trader.arena_score = calculateArenaScore(trader.roi!, trader.pnl, trader.max_drawdown, trader.win_rate, period)
        })
      )
      if (i + ENRICH_CONCURRENCY < toEnrich.length) await sleep(ENRICH_DELAY_MS)
    }
    logger.warn(`[${SOURCE}] Enriched ${enriched} traders with win_rate`)
  }

  const { saved, error } = await upsertTraders(supabase, top)

  // DISABLED 2026-03-12: Enrichment moved to batch-enrich to avoid Cloudflare 120s timeout
  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D' && false) {  // Disabled with "&& false"
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

export async function fetchBinanceSpot(
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
