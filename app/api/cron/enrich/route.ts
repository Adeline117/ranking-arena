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
  fetchBinancePositionHistory,
  fetchBybitEquityCurve,
  fetchBybitStatsDetail,
  fetchBybitPositionHistory,
  fetchOkxEquityCurve,
  fetchOkxStatsDetail,
  fetchOkxCurrentPositions,
  fetchOkxPositionHistory,
  fetchBitgetEquityCurve,
  fetchBitgetStatsDetail,
  fetchBitgetPositionHistory,
  fetchHyperliquidPositionHistory,
  fetchGmxPositionHistory,
  fetchHtxEquityCurve,
  fetchHtxStatsDetail,
  upsertEquityCurve,
  upsertStatsDetail,
  upsertPositionHistory,
  upsertPortfolio,
  enhanceStatsWithDerivedMetrics,
  type StatsDetail,
  type EquityCurvePoint,
  type PositionHistoryItem,
} from '@/lib/cron/fetchers/enrichment'
import { sleep } from '@/lib/cron/fetchers/shared'
import { captureMessage } from '@/lib/utils/logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

// Retry configuration
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
}

/**
 * Execute a function with exponential backoff retry
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options = RETRY_CONFIG
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt === options.maxAttempts) {
        logger.error(`Enrichment ${context} failed after retries`, { attempts: attempt }, lastError)
        throw lastError
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        options.maxDelayMs
      )
      logger.warn(`Enrichment ${context} attempt ${attempt} failed, retrying`, { delay: Math.round(delay) })
      await sleep(delay)
    }
  }

  throw lastError
}

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1' // Tokyo — avoids exchange geo-blocking
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface EnrichmentConfig {
  platform: string
  fetchEquityCurve?: (traderId: string, days: number) => Promise<Array<{ date: string; roi: number; pnl: number | null }>>
  fetchStatsDetail?: (traderId: string) => Promise<StatsDetail | null>
  fetchPositionHistory?: (traderId: string) => Promise<PositionHistoryItem[]>
  fetchCurrentPositions?: (traderId: string) => Promise<PositionHistoryItem[]>
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
    fetchPositionHistory: fetchBinancePositionHistory,
    concurrency: 5,
    delayMs: 1000,
  },
  binance_spot: {
    platform: 'binance_spot',
    fetchEquityCurve: async (traderId, days) => {
      const timeRangeMap: Record<number, 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'> = {
        7: 'WEEKLY',
        30: 'MONTHLY',
        90: 'QUARTERLY',
      }
      return fetchBinanceEquityCurve(traderId, timeRangeMap[days] || 'QUARTERLY')
    },
    fetchStatsDetail: fetchBinanceStatsDetail,
    concurrency: 4,
    delayMs: 1200,
  },
  bybit: {
    platform: 'bybit',
    fetchEquityCurve: fetchBybitEquityCurve,
    fetchStatsDetail: fetchBybitStatsDetail,
    fetchPositionHistory: fetchBybitPositionHistory,
    concurrency: 5,
    delayMs: 1000,
  },
  bybit_spot: {
    platform: 'bybit_spot',
    fetchEquityCurve: fetchBybitEquityCurve,
    fetchStatsDetail: fetchBybitStatsDetail,
    concurrency: 4,
    delayMs: 1200,
  },
  okx_futures: {
    platform: 'okx_futures',
    fetchEquityCurve: fetchOkxEquityCurve,
    fetchStatsDetail: fetchOkxStatsDetail,
    fetchPositionHistory: fetchOkxPositionHistory,
    fetchCurrentPositions: fetchOkxCurrentPositions,
    concurrency: 3,
    delayMs: 1500,
  },
  bitget_futures: {
    platform: 'bitget_futures',
    fetchEquityCurve: fetchBitgetEquityCurve,
    fetchStatsDetail: fetchBitgetStatsDetail,
    fetchPositionHistory: fetchBitgetPositionHistory,
    concurrency: 2,
    delayMs: 2000,
  },
  bitget_spot: {
    platform: 'bitget_spot',
    fetchEquityCurve: fetchBitgetEquityCurve,
    fetchStatsDetail: fetchBitgetStatsDetail,
    concurrency: 2,
    delayMs: 2000,
  },
  hyperliquid: {
    platform: 'hyperliquid',
    fetchPositionHistory: fetchHyperliquidPositionHistory,
    concurrency: 3,
    delayMs: 500,
  },
  gmx: {
    platform: 'gmx',
    fetchPositionHistory: fetchGmxPositionHistory,
    concurrency: 2,
    delayMs: 1000,
  },
  mexc: {
    platform: 'mexc',
    // MEXC has limited API access, stats-only enrichment
    concurrency: 2,
    delayMs: 2000,
  },
  dydx: {
    platform: 'dydx',
    // dYdX on-chain data, position history focused
    fetchPositionHistory: fetchGmxPositionHistory, // Similar GraphQL pattern
    concurrency: 2,
    delayMs: 1500,
  },
  kucoin: {
    platform: 'kucoin',
    // KuCoin limited access
    concurrency: 2,
    delayMs: 2500,
  },
  gains: {
    platform: 'gains',
    // Gains Network on-chain
    concurrency: 2,
    delayMs: 1500,
  },
  jupiter_perps: {
    platform: 'jupiter_perps',
    // Jupiter on Solana
    concurrency: 2,
    delayMs: 1500,
  },
  aevo: {
    platform: 'aevo',
    // Aevo DEX
    concurrency: 2,
    delayMs: 1500,
  },
  htx_futures: {
    platform: 'htx_futures',
    fetchEquityCurve: fetchHtxEquityCurve,
    fetchStatsDetail: fetchHtxStatsDetail,
    concurrency: 2,
    delayMs: 2000,
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
  if (!secret) {
    logger.error('[enrich] CRON_SECRET not configured')
    return process.env.NODE_ENV === 'development' // Only allow in dev mode
  }

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
  const url0 = new URL(req.url)
  const plog = await PipelineLogger.start(`enrich-${url0.searchParams.get('platform') || 'all'}`)

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

    logger.warn(`[enrich] Processing ${traders.length} ${platformKey} traders for ${period}`)

    // Process in batches
    for (let i = 0; i < traders.length; i += config.concurrency) {
      const batch = traders.slice(i, i + config.concurrency)

      await Promise.all(
        batch.map(async (trader) => {
          const traderId = trader.source_trader_id
          try {
            let curve: EquityCurvePoint[] = []

            // Fetch and save equity curve with retry
            if (config.fetchEquityCurve) {
              curve = await withRetry(
                () => config.fetchEquityCurve!(traderId, days),
                `${platformKey}:${traderId} equity curve`
              )
              if (curve.length > 0) {
                await withRetry(
                  () => upsertEquityCurve(supabase, platformKey, traderId, period, curve),
                  `${platformKey}:${traderId} save equity curve`
                )
              }
            }

            // Fetch and save position history with retry
            if (config.fetchPositionHistory) {
              const positions = await withRetry(
                () => config.fetchPositionHistory!(traderId),
                `${platformKey}:${traderId} position history`
              )
              if (positions.length > 0) {
                await withRetry(
                  () => upsertPositionHistory(supabase, platformKey, traderId, positions),
                  `${platformKey}:${traderId} save position history`
                )
              }
            }

            // Fetch and save current positions (portfolio) with retry
            if (config.fetchCurrentPositions) {
              const currentPos = await withRetry(
                () => config.fetchCurrentPositions!(traderId),
                `${platformKey}:${traderId} current positions`
              )
              if (currentPos.length > 0) {
                await withRetry(
                  () => upsertPortfolio(supabase, platformKey, traderId,
                    currentPos.map((p) => ({
                      symbol: p.symbol,
                      direction: p.direction,
                      investedPct: null,
                      entryPrice: p.entryPrice,
                      pnl: p.pnlUsd,
                    }))
                  ),
                  `${platformKey}:${traderId} save current positions`
                )
              }
            }

            // Fetch and save stats detail with retry
            if (config.fetchStatsDetail) {
              let stats = await withRetry(
                () => config.fetchStatsDetail!(traderId),
                `${platformKey}:${traderId} stats detail`
              )
              if (stats) {
                // Phase 4: Enhance stats with derived metrics from equity curve
                if (curve.length > 0) {
                  stats = enhanceStatsWithDerivedMetrics(stats, curve, period)
                }
                await withRetry(
                  () => upsertStatsDetail(supabase, platformKey, traderId, period, stats!),
                  `${platformKey}:${traderId} save stats detail`
                )
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

  logger.warn(`[enrich] Completed in ${duration}ms: ${totalEnriched} enriched, ${totalFailed} failed`)

  // Alert if failure rate is too high (>30%)
  const total = totalEnriched + totalFailed
  const failureRate = total > 0 ? totalFailed / total : 0

  if (failureRate > 0.3 && totalFailed >= 5) {
    // Log to Sentry
    await captureMessage(
      `[Enrichment] High failure rate: ${(failureRate * 100).toFixed(0)}% (${totalFailed}/${total})`,
      'error',
      {
        period,
        platforms: platforms.join(', '),
        failureRate: failureRate.toFixed(2),
        totalFailed,
        totalEnriched,
        errors: Object.entries(results)
          .filter(([, r]) => r.failed > 0)
          .map(([p, r]) => `${p}: ${r.errors.slice(0, 2).join('; ')}`)
          .join(' | '),
      }
    )

    // Send alert (rate limited to 1 per 10 minutes per platform)
    await sendRateLimitedAlert(
      {
        title: 'Enrichment failure rate过高',
        message: `${period} period enrichment failure rate ${(failureRate * 100).toFixed(0)}%\nFailed: ${totalFailed}/${total}`,
        level: failureRate > 0.5 ? 'critical' : 'warning',
        details: {
          '周期': period,
          '平台': platforms.join(', '),
          '成功': totalEnriched,
          '失败': totalFailed,
          'failure rate': `${(failureRate * 100).toFixed(1)}%`,
        },
      },
      `enrichment:${period}`,
      600000 // 10 minutes
    )
  }

  if (totalFailed === 0) {
    await plog.success(totalEnriched, { period, duration })
  } else {
    await plog.error(
      new Error(`${totalFailed}/${totalEnriched + totalFailed} enrichments failed`),
      { period, duration, totalEnriched, totalFailed }
    )
  }

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
