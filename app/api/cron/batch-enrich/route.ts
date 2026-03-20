/**
 * Batch enrich dispatcher
 *
 * Calls enrichment logic INLINE (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   period=90D|30D|7D|all (default: 90D) - which time period to enrich
 *     When period=all, runs all 3 periods (90D, 30D, 7D) sequentially
 *   all=true - enrich all platforms including lower priority ones
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { runEnrichment, type EnrichmentResult } from '@/lib/cron/enrichment-runner'
import { createLogger } from '@/lib/utils/logger'
import { env } from '@/lib/env'

const logger = createLogger('batch-enrich')

export const dynamic = 'force-dynamic'
export const maxDuration = 800 // Vercel Pro max

// Platform configs with limits per period
// EMERGENCY REDUCTION (2026-03-13 Round 2): batch-enrich STILL hitting 600s timeout
// Onchain platforms: 50/40/30 → 30/25/20 (more aggressive)
// CEX platforms: slightly reduced to balance load
// 2026-03-20: FULL COVERAGE — limits sized to actual leaderboard counts
// With offset rotation, each run processes a different slice. Over 6 runs/day = full coverage.
const PLATFORM_LIMITS: Record<string, { limit90: number; limit30: number; limit7: number }> = {
  // Batch-cached (no per-trader API calls, instant)
  bitunix: { limit90: 500, limit30: 500, limit7: 500 },
  xt: { limit90: 100, limit30: 100, limit7: 100 },
  blofin: { limit90: 300, limit30: 300, limit7: 300 },
  bitfinex: { limit90: 120, limit30: 120, limit7: 120 },
  toobit: { limit90: 100, limit30: 100, limit7: 100 },
  coinex: { limit90: 200, limit30: 200, limit7: 200 },
  // Large CEX — API per trader, need offset rotation for full coverage
  binance_futures: { limit90: 300, limit30: 300, limit7: 300 },
  okx_futures: { limit90: 300, limit30: 300, limit7: 300 },
  hyperliquid: { limit90: 200, limit30: 200, limit7: 200 },
  htx_futures: { limit90: 200, limit30: 200, limit7: 200 },
  etoro: { limit90: 200, limit30: 200, limit7: 200 },
  drift: { limit90: 300, limit30: 300, limit7: 300 },
  gmx: { limit90: 200, limit30: 200, limit7: 200 },
  gateio: { limit90: 200, limit30: 200, limit7: 200 },
  // Medium CEX
  bitget_futures: { limit90: 50, limit30: 50, limit7: 50 },
  mexc: { limit90: 150, limit30: 150, limit7: 150 },
  btcc: { limit90: 50, limit30: 50, limit7: 50 },
  phemex: { limit90: 80, limit30: 80, limit7: 80 },
  bingx: { limit90: 40, limit30: 40, limit7: 40 },
  okx_spot: { limit90: 40, limit30: 40, limit7: 40 },
  okx_web3: { limit90: 400, limit30: 400, limit7: 400 },
  // DEX on-chain
  jupiter_perps: { limit90: 100, limit30: 100, limit7: 100 },
  gains: { limit90: 30, limit30: 25, limit7: 15 },
  // Re-enabled platforms
  dydx: { limit90: 200, limit30: 200, limit7: 200 },
  aevo: { limit90: 200, limit30: 200, limit7: 200 },
  // VPS scrapers (slow)
  bybit: { limit90: 100, limit30: 100, limit7: 100 },
  weex: { limit90: 30, limit30: 30, limit7: 30 },
  kucoin: { limit90: 25, limit30: 25, limit7: 25 },
  bingx_spot: { limit90: 20, limit30: 20, limit7: 20 },
}

// 2026-03-20: Full coverage — batch-cached first (instant), then API-per-trader
const HIGH_PRIORITY = [
  'bitunix', 'xt', 'blofin', 'bitfinex', 'toobit', 'coinex', // batch-cached: instant
  'binance_futures', 'okx_futures', 'hyperliquid', 'jupiter_perps', // fast APIs
]
const MEDIUM_PRIORITY = [
  'htx_futures', 'gateio', 'mexc', 'drift', 'gmx', 'gains',
  'bitget_futures', 'btcc', 'etoro', 'phemex', 'bingx', 'okx_spot', 'okx_web3',
  'dydx', 'aevo', // re-enabled via Copin + indexer
]
const LOW_PRIORITY = ['bybit', 'weex', 'kucoin', 'bingx_spot'] // VPS scrapers, run last
const LOWER_PRIORITY: string[] = []

interface BatchResult {
  platform: string
  period: string
  status: 'success' | 'error'
  durationMs: number
  enriched?: number
  failed?: number
  error?: string
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const periodParam = request.nextUrl.searchParams.get('period') || '90D'
  const enrichAll = request.nextUrl.searchParams.get('all') === 'true'

  const VALID_PERIODS = ['7D', '30D', '90D'] as const
  type Period = typeof VALID_PERIODS[number]

  if (periodParam !== 'all' && !VALID_PERIODS.includes(periodParam as Period)) {
    return NextResponse.json({ error: 'Invalid period, must be 7D, 30D, 90D, or all' }, { status: 400 })
  }

  const periodsToRun: Period[] = periodParam === 'all'
    ? ['90D', '30D', '7D']
    : [periodParam as Period]

  // Determine which platforms to enrich
  // Low priority platforms (dydx, binance_spot) run LAST to prevent blocking
  let platforms: string[]
  if (enrichAll) {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY, ...LOW_PRIORITY]
  } else {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOW_PRIORITY]
  }

  const results: BatchResult[] = []
  const plog = await PipelineLogger.start(`batch-enrich-${periodParam}`, { period: periodParam, enrichAll, platforms })

  // Safety timeout: ensure plog gets called before Vercel kills the function at 900s
  const SAFETY_TIMEOUT_MS = 880_000 // 880s for 900s limit (20s buffer)
  const safetyTimer = setTimeout(async () => {
    try {
      await plog.error(new Error('Safety timeout: function approaching 600s limit'), { results })
    } catch { /* best effort */ }
  }, SAFETY_TIMEOUT_MS)

  // Per-platform enrichment timeout
  // EMERGENCY FIX Round 5 (2026-03-14): binance_spot repeatedly hanging 45-76min
  // ROOT CAUSE: fetchBinanceEquityCurve + fetchBinanceStatsDetail both call API with 15s timeout
  //             If both hang repeatedly (retry logic), 15s×3 retries×2 calls = 90s+ per trader
  // FIX: Aggressive timeout reduction for ALL platforms to prevent cascade hangs
  //      CEX: 30s (single) / 20s (multi) - enough for 1-2 API calls
  //      Onchain: 60s (single) / 40s (multi) - GraphQL/RPC needs slightly more time
  const ONCHAIN_PLATFORMS = new Set(['gmx', 'jupiter_perps', 'hyperliquid', 'drift', 'aevo', 'gains'])
  const ENRICH_TIMEOUT_MS = periodsToRun.length > 1 ? 60_000 : 90_000  // 60s/90s
  const ONCHAIN_TIMEOUT_MS = periodsToRun.length > 1 ? 120_000 : 180_000  // 120s/180s

  const functionStart = Date.now()
  // Budget per period: divide 870s (leaving 30s buffer from 900s total) by number of periods
  const PER_PERIOD_BUDGET_MS = Math.floor(870_000 / periodsToRun.length)

  // Run each period sequentially (when period=all, this runs 90D → 30D → 7D)
  for (const period of periodsToRun) {
    // Bail early if we're running low on time (leave 50s for cleanup/logging)
    const elapsed = Date.now() - functionStart
    if (elapsed > 850_000) {
      results.push({ platform: '*', period, status: 'error', durationMs: 0, error: `Skipped: ${Math.round(elapsed / 1000)}s elapsed, <50s remaining` })
      continue
    }

    const periodStart = Date.now()

    // Run enrichments inline in parallel batches of 7 (increased from 5 to reduce total time)
    // EMERGENCY INCREASE (2026-03-13): With 12 platforms, 7 concurrent = 2 batches × ~120s = ~240s
    const BATCH_CONCURRENCY = 7
    for (let i = 0; i < platforms.length; i += BATCH_CONCURRENCY) {
      // Check per-period budget before starting next batch
      if (Date.now() - periodStart > PER_PERIOD_BUDGET_MS) {
        const remaining = platforms.slice(i)
        for (const p of remaining) {
          results.push({ platform: p, period, status: 'error', durationMs: 0, error: `Skipped: period budget ${Math.round(PER_PERIOD_BUDGET_MS / 1000)}s exhausted` })
        }
        break
      }
      const batch = platforms.slice(i, i + BATCH_CONCURRENCY)
      const batchResults = await Promise.allSettled(
        batch.map(async (platform): Promise<BatchResult> => {
          const config = PLATFORM_LIMITS[platform]
          if (!config) return { platform, period, status: 'error', durationMs: 0, error: 'No config' }

          const limit = period === '90D' ? config.limit90 : period === '30D' ? config.limit30 : config.limit7
          const start = Date.now()

          try {
            // Wrap enrichment in a timeout to prevent stuck jobs
            // Use longer timeout for onchain platforms (360s vs 240s)
            const timeoutMs = ONCHAIN_PLATFORMS.has(platform) ? ONCHAIN_TIMEOUT_MS : ENRICH_TIMEOUT_MS
            const result: EnrichmentResult = await Promise.race([
              runEnrichment({ platform, period, limit }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Enrichment ${platform}/${period} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
              ),
            ])
            return {
              platform, period,
              status: result.ok ? 'success' : 'error',
              durationMs: Date.now() - start,
              enriched: result.summary.enriched,
              failed: result.summary.failed,
              error: result.ok ? undefined : `${result.summary.failed} enrichments failed`,
            }
          } catch (err) {
            return {
              platform, period,
              status: 'error',
              durationMs: Date.now() - start,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        })
      )
      
      // Handle Promise.allSettled results
      const settled = batchResults.map(r => 
        r.status === 'fulfilled' ? r.value : {
          platform: 'unknown',
          period,
          status: 'error' as const,
          durationMs: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason)
        }
      )
      results.push(...settled)
      
      const batchSucceeded = settled.filter(r => r.status === 'success').length
      const batchFailed = settled.length - batchSucceeded
      logger.info(`Batch ${period}: ${batchSucceeded} success, ${batchFailed} failed`)
    }
  }

  clearTimeout(safetyTimer)
  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.length - succeeded

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else {
    await plog.error(
      new Error(`${failed}/${results.length} enrichments failed`),
      { results }
    )
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    period: periodParam,
    periodsRun: periodsToRun,
    platforms: platforms.length,
    succeeded,
    failed,
    results,
  })
}
