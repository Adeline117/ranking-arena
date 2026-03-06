/**
 * Bybit Copy Trading — Inline fetcher for Vercel serverless
 * API: https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
 *
 * Uses the beehive public API directly via api2.bybit.com (no WAF).
 * metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
 *
 * Strategy:
 * 1. Try api2.bybit.com (bypasses Akamai WAF on www.bybit.com)
 * 2. Fall back to Cloudflare Worker proxy
 * 3. Fall back to VPS proxy
 * 4. Fall back to www.bybit.com/x-api (may be WAF-blocked)
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
import { fetchBybitEquityCurve, fetchBybitStatsDetail, upsertEquityCurve, upsertStatsDetail, enhanceStatsWithDerivedMetrics, type EquityCurvePoint } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bybit'
// api2.bybit.com bypasses Akamai WAF that blocks www.bybit.com/x-api
const DIRECT_API_URL =
  'https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const TARGET = 500
const PAGE_SIZE = 50

// Phase 2: Enrichment settings - increased coverage from 50 to 100
const ENRICH_LIMIT = 300
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

  // Strategy 1: Try direct API first (works from non-US IPs)
  try {
    const data = await fetchJson<BybitApiResponse>(directUrl)
    if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
      return data
    }
  } catch (err) {
    logger.warn(`[bybit] Direct API failed: ${err instanceof Error ? err.message : err}`)
  }

  // Strategy 2: Try Cloudflare Worker proxy
  try {
    const data = await fetchJson<BybitApiResponse>(proxyUrl)
    if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
      return data
    }
  } catch (err) {
    logger.warn(`[bybit] Proxy failed: ${err instanceof Error ? err.message : err}`)
  }

  // Strategy 3: VPS proxy (Tokyo/Singapore VPS with clean IP)
  const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_JP
  if (vpsUrl) {
    try {
      logger.warn(`[bybit] Trying VPS proxy...`)
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
      })
      if (res.ok) {
        const data = (await res.json()) as BybitApiResponse
        if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
          return data
        }
      }
    } catch (err) {
      logger.warn(`[bybit] VPS proxy failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Strategy 4: Try www.bybit.com/x-api fallback (original endpoint, may be WAF-blocked)
  try {
    const wwwUrl = directUrl.replace('api2.bybit.com/fapi', 'www.bybit.com/x-api/fapi')
    const data = await fetchJson<BybitApiResponse>(wwwUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Referer: 'https://www.bybit.com/en/copy-trading',
        Origin: 'https://www.bybit.com',
      },
    })
    if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
      return data
    }
  } catch (err) {
    logger.warn(`[bybit] www.bybit.com fallback failed: ${err instanceof Error ? err.message : err}`)
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
      lastError = 'WAF-blocked from direct API, CF proxy, and VPS proxy'
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
    const roi = parsePercent(mv[0])
    if (roi == null || roi === 0) continue

    const maxDrawdown = parsePercent(mv[1])
    const pnl = parseNum(mv[2])
    const winRate = normalizeWinRate(parsePercent(mv[3]))
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
  // Extended to all periods (not just 90D)
  if (saved > 0) {
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
