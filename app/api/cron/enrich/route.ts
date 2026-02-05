/**
 * Independent Enrichment Cron Job
 *
 * Enriches trader data (equity curves, stats detail) separately from main fetch
 * to avoid Vercel's 60s timeout and reduce load on main fetch jobs.
 *
 * Supports:
 * - Batch processing with configurable limits
 * - Platform filtering via query param
 * - Period filtering via query param
 *
 * Query params:
 * - platform: Filter by platform (e.g., binance_futures, bybit, okx_futures)
 * - period: Filter by period (7D, 30D, 90D)
 * - limit: Max traders to enrich per platform (default: 50)
 * - offset: Skip N traders (for pagination)
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  fetchBinanceEquityCurve,
  fetchBinanceStatsDetail,
  fetchBybitEquityCurve,
  fetchBybitStatsDetail,
  fetchOkxStatsDetail,
  upsertEquityCurve,
  upsertStatsDetail,
  enhanceStatsWithDerivedMetrics,
  type StatsDetail,
  type EquityCurvePoint,
} from '@/lib/cron/fetchers/enrichment'
import { sleep } from '@/lib/cron/fetchers/shared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface EnrichmentConfig {
  platform: string
  fetchEquityCurve?: (traderId: string, days: number) => Promise<Array<{ date: string; roi: number; pnl: number | null }>>
  fetchStatsDetail?: (traderId: string) => Promise<StatsDetail | null>
  concurrency: number
  delayMs: number
}

const PLATFORM_CONFIGS: Record<string, EnrichmentConfig> = {
  binance_futures: {
    platform: 'binance_futures',
    fetchEquityCurve: async (traderId, days) => {
      const timeRangeMap: Record<number, 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'> = {
        7: 'WEEKLY',
        30: 'MONTHLY',
        90: 'QUARTERLY',
      }
      return fetchBinanceEquityCurve(traderId, timeRangeMap[days] || 'QUARTERLY')
    },
    fetchStatsDetail: fetchBinanceStatsDetail,
    concurrency: 5,
    delayMs: 1000,
  },
  bybit: {
    platform: 'bybit',
    fetchEquityCurve: fetchBybitEquityCurve,
    fetchStatsDetail: fetchBybitStatsDetail,
    concurrency: 5,
    delayMs: 1000,
  },
  okx_futures: {
    platform: 'okx_futures',
    fetchStatsDetail: fetchOkxStatsDetail,
    concurrency: 3,
    delayMs: 500,
  },
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // No secret = allow all (dev mode)

  const authHeader = req.headers.get('authorization')
  if (authHeader === `Bearer ${secret}`) return true

  const url = new URL(req.url)
  if (url.searchParams.get('secret') === secret) return true

  return false
}

export async function GET(req: Request) {
  // Support GET requests from Vercel cron
  return handleEnrichment(req)
}

export async function POST(req: Request) {
  return handleEnrichment(req)
}

async function handleEnrichment(req: Request) {
  const startTime = Date.now()

  // 1) Authorize
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 2) Get Supabase client
  const supabase = getSupabaseClient()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  // 3) Parse params
  const url = new URL(req.url)
  const platformParam = url.searchParams.get('platform')
  const period = url.searchParams.get('period') || '90D'
  const limit = parseInt(url.searchParams.get('limit') || '50')
  const offset = parseInt(url.searchParams.get('offset') || '0')

  const platforms = platformParam
    ? [platformParam].filter((p) => p in PLATFORM_CONFIGS)
    : Object.keys(PLATFORM_CONFIGS)

  if (platforms.length === 0) {
    return NextResponse.json({
      error: 'Invalid platform',
      supported: Object.keys(PLATFORM_CONFIGS),
    }, { status: 400 })
  }

  const daysMap: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
  const days = daysMap[period] || 90

  const results: Record<string, { enriched: number; failed: number; errors: string[] }> = {}

  // 4) Process each platform
  for (const platformKey of platforms) {
    const config = PLATFORM_CONFIGS[platformKey]
    if (!config) continue

    results[platformKey] = { enriched: 0, failed: 0, errors: [] }

    // Fetch top traders for this platform that need enrichment
    const { data: traders, error: fetchError } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', platformKey)
      .eq('season_id', period)
      .order('arena_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fetchError || !traders) {
      results[platformKey].errors.push(`Failed to fetch traders: ${fetchError?.message}`)
      continue
    }

    console.warn(`[enrich] Processing ${traders.length} ${platformKey} traders for ${period}`)

    // Process in batches
    for (let i = 0; i < traders.length; i += config.concurrency) {
      const batch = traders.slice(i, i + config.concurrency)

      await Promise.all(
        batch.map(async (trader) => {
          const traderId = trader.source_trader_id
          try {
            let curve: EquityCurvePoint[] = []

            // Fetch and save equity curve
            if (config.fetchEquityCurve) {
              curve = await config.fetchEquityCurve(traderId, days)
              if (curve.length > 0) {
                await upsertEquityCurve(supabase, platformKey, traderId, period, curve)
              }
            }

            // Fetch and save stats detail
            if (config.fetchStatsDetail) {
              let stats = await config.fetchStatsDetail(traderId)
              if (stats) {
                // Phase 4: Enhance stats with derived metrics from equity curve
                if (curve.length > 0) {
                  stats = enhanceStatsWithDerivedMetrics(stats, curve, period)
                }
                await upsertStatsDetail(supabase, platformKey, traderId, period, stats)
              }
            }

            results[platformKey].enriched++
          } catch (err) {
            results[platformKey].failed++
            const errMsg = err instanceof Error ? err.message : String(err)
            if (results[platformKey].errors.length < 5) {
              results[platformKey].errors.push(`${traderId}: ${errMsg}`)
            }
          }
        })
      )

      // Rate limiting
      if (i + config.concurrency < traders.length) {
        await sleep(config.delayMs)
      }
    }
  }

  const duration = Date.now() - startTime
  const totalEnriched = Object.values(results).reduce((sum, r) => sum + r.enriched, 0)
  const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed, 0)

  console.warn(`[enrich] Completed in ${duration}ms: ${totalEnriched} enriched, ${totalFailed} failed`)

  return NextResponse.json({
    ok: totalFailed === 0,
    duration,
    period,
    summary: {
      total: totalEnriched + totalFailed,
      enriched: totalEnriched,
      failed: totalFailed,
    },
    results,
  })
}
