/**
 * Binance Futures Copy Trading — Inline fetcher for Vercel serverless
 * API: POST https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list
 *
 * Converted from app/api/cron/fetch-traders/binance-inline/route.ts
 * ROI from API is a decimal (e.g. 0.5 = 50%), converted to percentage.
 *
 * [WARN] GEO-BLOCKED from US IPs (HTTP 451).
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
  getWinRateFormat,
} from '../shared'
import {
  fetchBinanceEquityCurve,
  fetchBinancePositionHistory,
  fetchBinanceStatsDetail,
  upsertEquityCurve,
  upsertPositionHistory,
  upsertStatsDetail,
  upsertAssetBreakdown,
  calculateAssetBreakdown,
  enhanceStatsWithDerivedMetrics,
  type EquityCurvePoint,
} from '../enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'binance_futures'
const API_URL =
  'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'
const _PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
// Binance caps at ~30 results/page regardless of pageSize.
// With VPS proxy fallback (~2s/page), TARGET=500 keeps within Vercel 300s limit.
const TARGET = 500
const PAGE_SIZE = 30

// Phase 2: Enrichment settings
const ENRICH_LIMIT = 100
const ENRICH_CONCURRENCY = 5
const ENRICH_DELAY_MS = 1000

// Futures API may use either number or string format - trying both
const PERIOD_MAP: Record<string, string> = { '7D': '7D', '30D': '30D', '90D': '90D' }

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: 'https://www.binance.com',
  Referer: 'https://www.binance.com/en/copy-trading',
}

// Strategy cache: once we find a working method, reuse it for all subsequent pages
let _cachedStrategy: 'direct' | 'vps' | null = null

// Helper to fetch with proxy fallback (direct → VPS proxy)
// Caches the working strategy to avoid wasting time on failed strategies for every page
// Falls back on geo-block (451/403) AND timeouts — Vercel hnd1 often times out to Binance
async function fetchWithProxyFallback<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown }
): Promise<T> {
  const vpsUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP

  // If we already know VPS works, skip direct entirely
  if (_cachedStrategy === 'vps' && vpsUrl) {
    return await fetchViaVps<T>(vpsUrl, url, opts)
  }

  // If no VPS configured, go direct only
  if (!vpsUrl) {
    const result = await fetchJson<T>(url, { ...opts, timeoutMs: 10000 })
    _cachedStrategy = 'direct'
    return result
  }

  // Try direct first (short timeout since we have VPS fallback)
  try {
    const result = await fetchJson<T>(url, { ...opts, timeoutMs: 8000 })
    _cachedStrategy = 'direct'
    return result
  } catch (directErr) {
    const msg = directErr instanceof Error ? directErr.message : ''
    const isBlocked = msg.includes('451') || msg.includes('403') || msg.includes('Access Denied') || msg.includes('geo-blocked')
    const isTimeout = msg.includes('abort') || msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')

    // Only fallback for blockable/timeout errors
    if (!isBlocked && !isTimeout) throw directErr

    // Direct failed (geo-blocked or timeout) → try VPS proxy
    try {
      logger.warn(`[binance-futures] Direct failed (${isBlocked ? 'geo-blocked' : 'timeout'}), switching to VPS proxy`)
      const result = await fetchViaVps<T>(vpsUrl, url, opts)
      _cachedStrategy = 'vps'
      return result
    } catch (vpsErr) {
      logger.warn(`[binance-futures] VPS proxy also failed: ${vpsErr instanceof Error ? vpsErr.message : String(vpsErr)}`)
    }

    throw new Error(
      `Direct ${isBlocked ? 'geo-blocked' : 'timed out'} and VPS proxy failed. ` +
      `Direct: ${msg}`)
  }
}

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BinanceTrader {
  portfolioId?: string
  leadPortfolioId?: string
  nickName?: string
  nickname?: string
  avatarUrl?: string
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
  const timeRange = PERIOD_MAP[period] || '90D'
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
        portfolioType: 'ALL',
      }

      let data: BinanceApiResponse
      try {
        data = await fetchWithProxyFallback<BinanceApiResponse>(API_URL, {
          method: 'POST',
          headers: HEADERS,
          body,
        })
      } catch (err) {
        // Binance returns HTTP 451 for geo-blocked requests
        const msg = err instanceof Error ? err.message : ''
        if (msg.includes('451') || msg.includes('403')) {
          return { total: 0, saved: 0, error: 'Geo-blocked (HTTP 451/403) — proxy fallback failed or not configured' }
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
    } catch (err) {
      logger.warn(`[${SOURCE}] Pagination stopped at page ${page}: ${err instanceof Error ? err.message : String(err)}`)
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
    // NOTE: This is ALL-TIME ROI regardless of timeRange parameter.
    // timeRange affects which traders appear (sorted by period performance),
    // but the roi field is always the same all-time value.
    // We write it for all periods as the best available estimate.
    // Enrichment (equity curve) can later provide period-specific ROI.
    const roi = roiRaw * 100
    const pnl = parseNum(t.pnl)
    const wrRaw = parseNum(t.winRate)
    const winRate = normalizeWinRate(wrRaw, getWinRateFormat(SOURCE))
    const mddRaw = parseNum(t.maxDrawdown ?? t.mdd)
    const maxDrawdown = mddRaw != null ? Math.abs(mddRaw) : null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: t.nickname || t.nickName || null,
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
      avatar_url: t.userPhotoUrl || t.avatarUrl || null,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Phase 2: Enrich top traders with equity curve, position history, and stats detail
  // Skip enrichment when using VPS proxy — enrichment APIs also geo-blocked,
  // DISABLED 2026-03-12: Enrichment moved to batch-enrich to avoid Cloudflare 120s timeout
  // Inline enrichment causes batch-fetch-traders to exceed timeout when combined with fetch
  // each failed call wastes ~30s. Use batch-enrich cron instead.
  if (saved > 0 && _cachedStrategy !== 'vps' && false) {  // Disabled with "&& false"
    const toEnrich = top.slice(0, ENRICH_LIMIT)
    logger.info(`[${SOURCE}] Enriching ${toEnrich.length} traders for ${period}...`)

    let enrichedCount = 0
    for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
      const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY)
      await Promise.all(
        batch.map(async (trader) => {
          try {
            // Map period to Binance time range
            const timeRangeMap: Record<string, 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'> = {
              '7D': 'WEEKLY',
              '30D': 'MONTHLY',
              '90D': 'QUARTERLY',
            }
            const timeRange = timeRangeMap[period] || 'QUARTERLY'

            // Fetch and save equity curve
            let curve: EquityCurvePoint[] = []
            curve = await fetchBinanceEquityCurve(trader.source_trader_id, timeRange)
            if (curve.length > 0) {
              await upsertEquityCurve(supabase, SOURCE, trader.source_trader_id, period, curve)
            }

            // Fetch and save position history + asset breakdown (only for 90D to avoid redundant data)
            if (period === '90D') {
              const positions = await fetchBinancePositionHistory(trader.source_trader_id, 50)
              if (positions.length > 0) {
                await upsertPositionHistory(supabase, SOURCE, trader.source_trader_id, positions)

                // Calculate and save asset breakdown from positions
                const assetBreakdown = calculateAssetBreakdown(positions)
                if (assetBreakdown.length > 0) {
                  await upsertAssetBreakdown(supabase, SOURCE, trader.source_trader_id, period, assetBreakdown)
                }
              }
            }

            // Fetch and save stats detail with derived metrics
            let stats = await fetchBinanceStatsDetail(trader.source_trader_id)
            if (stats) {
              // Phase 4: Enhance with derived metrics from equity curve
              if (curve.length > 0) {
                stats = enhanceStatsWithDerivedMetrics(stats, curve, period)
              }
              await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
              enrichedCount++
            }
          } catch (err) {
            logger.warn(`[${SOURCE}] Enrichment failed for ${trader.source_trader_id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        })
      )
      if (i + ENRICH_CONCURRENCY < toEnrich.length) {
        await sleep(ENRICH_DELAY_MS)
      }
    }
    logger.info(`[${SOURCE}] Enrichment complete for ${period}: ${enrichedCount} stats details saved`)
  }

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
