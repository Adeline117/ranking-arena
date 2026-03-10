/**
 * Bybit Copy Trading — Inline fetcher for Vercel serverless
 * API: https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
 *
 * metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
 * NOTE: mv[2] is followerProfit (copier PnL), NOT trader PnL. Set pnl=null.
 *
 * Strategy:
 * 1. Try VPS Playwright scraper (bybitglobal.com — bypasses Akamai WAF)
 * 2. Try api2.bybit.com direct
 * 3. Fall back to Cloudflare Worker proxy
 * 4. Fall back to VPS generic proxy
 * 5. Fall back to www.bybit.com/x-api (may be WAF-blocked)
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
import { fetchBybitEquityCurve, fetchBybitStatsDetail, upsertEquityCurve, upsertStatsDetail, enhanceStatsWithDerivedMetrics, type EquityCurvePoint } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bybit'
// api2.bybit.com bypasses Akamai WAF that blocks www.bybit.com/x-api
const DIRECT_API_URL =
  'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
// VPS Playwright scraper: uses bybitglobal.com + browser to bypass Akamai WAF
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''
const TARGET = 500
const PAGE_SIZE = 50

// Phase 2: Enrichment settings
const ENRICH_LIMIT = 50
const ENRICH_CONCURRENCY = 5 // Increased concurrency
const ENRICH_DELAY_MS = 1000

const PERIOD_MAP: Record<string, string> = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
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
// Fetch helpers with proxy fallback
// ---------------------------------------------------------------------------

// Batch cache: prefetched page-1 data for all periods from a single VPS browser session
const _batchCache = new Map<string, BybitApiResponse>()

async function prefetchBatch(periods: string[]): Promise<void> {
  if (!VPS_SCRAPER_KEY) {
    logger.error(`[bybit] VPS_SCRAPER_KEY not set — Bybit requires VPS Playwright scraper (api2.bybit.com returns 403)`)
    return
  }
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
      logger.info(`[bybit] Batch prefetch: ${_batchCache.size}/${durations.length} periods cached`)
    } else {
      logger.error(`[bybit] VPS scraper returned HTTP ${res.status} — scraper may be down. SSH to VPS and run: pm2 restart arena-scraper`)
    }
  } catch (err) {
    logger.error(`[bybit] VPS scraper unreachable (${VPS_SCRAPER_URL}): ${err instanceof Error ? err.message : err} — check PM2 process on SG VPS`)
  }
}

// Cache which strategy works to avoid wasting time on failed strategies for subsequent pages
let _bybitStrategy: 'scraper' | 'direct' | 'cf_proxy' | 'vps_proxy' | 'www' | 'none' | null = null

async function fetchBybitPage(
  pageNo: number,
  pageSize: number,
  duration: string
): Promise<BybitApiResponse | null> {
  const directUrl =
    `${DIRECT_API_URL}?pageNo=${pageNo}&pageSize=${pageSize}` +
    `&dataDuration=${duration}` +
    `&sortField=LEADER_SORT_FIELD_SORT_ROI`

  const proxyUrl =
    `${PROXY_URL}/bybit/copy-trading?pageNo=${pageNo}&pageSize=${pageSize}&period=${duration}`

  // If we already know all strategies fail, don't waste time
  if (_bybitStrategy === 'none') return null

  // Scraper is slow (~73s/page) but reliable. Allow multi-page if batch cache missed.
  // Batch prefetch handles bulk data in ~55s, so multi-page scraper is rare fallback.

  // Strategy 0: Check batch cache (prefetched all periods in single browser session)
  if (pageNo === 1 && _batchCache.has(duration)) {
    const cached = _batchCache.get(duration)!
    _batchCache.delete(duration)
    if (!_bybitStrategy) _bybitStrategy = 'scraper'
    logger.info(`[bybit] Using batch-cached data for ${duration}`)
    return cached
  }

  // Strategy 1: VPS Playwright scraper (all pages, batch cache takes priority for page 1)
  if (VPS_SCRAPER_KEY && _batchCache.size === 0) {
    try {
      const url = `${VPS_SCRAPER_URL}/bybit/leaderboard?pageNo=${pageNo}&pageSize=${pageSize}&duration=${duration}`
      const res = await fetch(url, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(180_000),
      })
      if (res.ok) {
        const data = (await res.json()) as BybitApiResponse
        if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
          if (!_bybitStrategy) _bybitStrategy = 'scraper'
          return data
        }
      }
    } catch (err) {
      logger.warn(`[bybit] VPS scraper failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Strategy 2: Direct API (api2.bybit.com) — skip if already known to fail
  if (!_bybitStrategy || _bybitStrategy === 'direct') {
    try {
      const data = await fetchJson<BybitApiResponse>(directUrl, { timeoutMs: 10000 })
      if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
        _bybitStrategy = 'direct'
        return data
      }
    } catch (err) {
      logger.warn(`[bybit] Direct API failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Strategy 3: CF Worker proxy — skip if already known to fail
  if (!_bybitStrategy || _bybitStrategy === 'cf_proxy') {
    try {
      const data = await fetchJson<BybitApiResponse>(proxyUrl, { timeoutMs: 10000 })
      if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
        _bybitStrategy = 'cf_proxy'
        return data
      }
    } catch (err) {
      logger.warn(`[bybit] CF proxy failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Strategy 4: VPS generic proxy — skip if already known to fail
  if (!_bybitStrategy || _bybitStrategy === 'vps_proxy') {
    const vpsUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP
    if (vpsUrl) {
      try {
        const res = await fetch(vpsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
          },
          body: JSON.stringify({
            url: directUrl,
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
              Referer: 'https://www.bybit.com/en/copy-trading',
              Accept: 'application/json',
            },
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          const data = (await res.json()) as BybitApiResponse
          if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
            _bybitStrategy = 'vps_proxy'
            return data
          }
        }
      } catch (err) {
        logger.warn(`[bybit] VPS proxy failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  // If this is page 1 and nothing worked, mark all strategies as failed
  if (pageNo <= 1 && !_bybitStrategy) {
    _bybitStrategy = 'none'
    logger.warn(`[bybit] All strategies failed for page 1 — marking as unavailable`)
  }

  return null
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
  let lastError: string | undefined

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const data = await fetchBybitPage(pageNo, PAGE_SIZE, duration)

    if (!data) {
      lastError = 'All strategies failed (VPS scraper, direct API, CF proxy, VPS proxy)'
      break
    }

    const details = data.result?.leaderDetails || []
    if (details.length === 0) break

    for (const item of details) {
      const id = String(item.leaderUserId || item.leaderMark || '')
      if (!id || allTraders.has(id)) continue
      allTraders.set(id, item)
    }

    if (details.length < PAGE_SIZE || allTraders.size >= TARGET) break
    await sleep(500)
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data retrieved' }
  }

  // Map to TraderData
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const [id, item] of Array.from(allTraders)) {
    const mv = item.metricValues || []
    // metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
    // NOTE: mv[2] is followerProfit (copier PnL), NOT trader PnL — set null
    const roi = parsePercent(mv[0])
    if (roi == null || roi === 0) continue

    const maxDrawdown = parsePercent(mv[1])
    const pnl = null // mv[2] is followerProfit, not trader PnL
    const winRate = normalizeWinRate(parsePercent(mv[3]), getWinRateFormat(SOURCE))
    // mv[4] = PLRatio (盈亏比)
    const sharpeRatio = parsePercent(mv[5]) // Phase 1: 提取 Sharpe Ratio

    const followers = parseNum(item.currentFollowerCount)

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `Bybit_${id.slice(0, 8)}`,
      profile_url: `https://www.bybit.com/copyTrade/tradeInfo?leaderMark=${id}`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
      followers: followers != null ? Math.round(followers) : null,
      sharpe_ratio: sharpeRatio, // Phase 1: 保存 Sharpe Ratio
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
      avatar_url: item.profilePhoto || null,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Phase 2: Enrich top traders with equity curve and stats detail
  // Only enrich 90D to save time budget (enrichment APIs use same WAF-blocked endpoints)
  if (saved > 0 && period === '90D') {
    const toEnrich = top.slice(0, ENRICH_LIMIT)
    logger.info(`[${SOURCE}] Enriching ${toEnrich.length} traders for ${period}...`)

    // Map period to days for equity curve API
    const daysMap: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
    const days = daysMap[period] || 90

    let enrichedCount = 0
    for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
      const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY)
      await Promise.all(
        batch.map(async (trader) => {
          try {
            // Equity curve
            let curve: EquityCurvePoint[] = []
            curve = await fetchBybitEquityCurve(trader.source_trader_id, days)
            if (curve.length > 0) {
              await upsertEquityCurve(supabase, SOURCE, trader.source_trader_id, period, curve)
            }

            // Stats detail with derived metrics
            let stats = await fetchBybitStatsDetail(trader.source_trader_id)
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

export async function fetchBybit(
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
