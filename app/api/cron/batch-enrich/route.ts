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

const logger = createLogger('batch-enrich')

export const dynamic = 'force-dynamic'
export const maxDuration = 600 // Vercel Pro max: 10 minutes (was 300s)

// Platform configs with limits per period
// EMERGENCY REDUCTION (2026-03-13 Round 2): batch-enrich STILL hitting 600s timeout
// Onchain platforms: 50/40/30 → 30/25/20 (more aggressive)
// CEX platforms: slightly reduced to balance load
const PLATFORM_LIMITS: Record<string, { limit90: number; limit30: number; limit7: number }> = {
  binance_futures: { limit90: 150, limit30: 120, limit7: 80 }, // Reduced from 200/150/100
  binance_spot: { limit90: 80, limit30: 60, limit7: 40 }, // Reduced from 100/80/50
  // bybit/bybit_spot removed: api2.bybit.com endpoints return 404 globally (2026-03-10)
  okx_futures: { limit90: 60, limit30: 60, limit7: 50 }, // Reduced from 80/80/60
  bitget_futures: { limit90: 50, limit30: 50, limit7: 40 }, // Reduced from 60/60/50
  // bitget_spot removed: no public API exists (all endpoints 404)
  // ONCHAIN PLATFORMS: AGGRESSIVE REDUCTION Round 4 (2026-03-13 09:00)
  // 30D/7D still timing out - matched 90D and more aggressive 7D
  hyperliquid: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
  gmx: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
  htx_futures: { limit90: 25, limit30: 25, limit7: 15 }, // 30D: 30→25 (match 90D), 7D: 20→15
  gateio: { limit90: 30, limit30: 30, limit7: 20 }, // 30D: 35→30 (match 90D), 7D: 25→20
  mexc: { limit90: 30, limit30: 30, limit7: 20 }, // 30D: 35→30 (match 90D), 7D: 25→20
  drift: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
  dydx: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
  aevo: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
  gains: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
  // kwenta removed: Copin API stopped serving Kwenta data (2026-03-11)
  jupiter_perps: { limit90: 20, limit30: 20, limit7: 10 }, // 30D: 25→20 (match 90D), 7D: 15→10
}

// High priority platforms (always enriched)
// bybit removed: api2.bybit.com endpoints return 404 globally (2026-03-10)
// gmx removed from batch: runs in dedicated job due to >360s enrichment time (2026-03-11)
// dydx moved to end: consistently times out at 360s, blocking other platforms (2026-03-13)
const HIGH_PRIORITY = ['binance_futures', 'okx_futures', 'bitget_futures', 'hyperliquid', 'jupiter_perps']

// Medium priority (enriched with all=true or period=90D)
// bybit_spot removed: api2.bybit.com endpoints return 404 globally (2026-03-10)
// kwenta removed: Copin API stopped serving Kwenta data (2026-03-11)
const MEDIUM_PRIORITY = ['binance_spot', 'htx_futures', 'gateio', 'mexc', 'drift', 'aevo', 'gains']

// Low priority - dydx (moved here due to consistent 360s timeout blocking other platforms)
// Still enriched, but runs last to avoid blocking high/medium priority platforms
const DYDX_PRIORITY = ['dydx']

// Lower priority (enriched only with all=true)
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
  const cronSecret = process.env.CRON_SECRET
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
  // Always include dydx at the END to prevent it from blocking other platforms
  let platforms: string[]
  if (enrichAll) {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY, ...DYDX_PRIORITY]
  } else {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...DYDX_PRIORITY]
  }

  const results: BatchResult[] = []
  const plog = await PipelineLogger.start(`batch-enrich-${periodParam}`, { period: periodParam, enrichAll, platforms })

  // Safety timeout: ensure plog gets called before Vercel kills the function at 600s
  const SAFETY_TIMEOUT_MS = 580_000 // Was 280s for 300s limit, now 580s for 600s limit
  const safetyTimer = setTimeout(async () => {
    try {
      await plog.error(new Error('Safety timeout: function approaching 600s limit'), { results })
    } catch { /* best effort */ }
  }, SAFETY_TIMEOUT_MS)

  // Per-platform enrichment timeout
  // EMERGENCY REDUCTION (2026-03-13): All platforms hitting 600s timeout
  // Reduced from 360s to 180s for onchain, 240s to 120s for CEX
  // With reduced batch sizes (50/40/30), 180s should be sufficient
  const ONCHAIN_PLATFORMS = new Set(['gmx', 'dydx', 'jupiter_perps', 'hyperliquid', 'drift', 'aevo', 'gains'])
  const ENRICH_TIMEOUT_MS = periodsToRun.length > 1 ? 60_000 : 120_000
  const ONCHAIN_TIMEOUT_MS = periodsToRun.length > 1 ? 90_000 : 180_000

  const functionStart = Date.now()
  // Budget per period: divide 570s (leaving 30s buffer from 600s total) by number of periods
  const PER_PERIOD_BUDGET_MS = Math.floor(570_000 / periodsToRun.length)

  // Run each period sequentially (when period=all, this runs 90D → 30D → 7D)
  for (const period of periodsToRun) {
    // Bail early if we're running low on time (leave 50s for cleanup/logging)
    const elapsed = Date.now() - functionStart
    if (elapsed > 550_000) {
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
