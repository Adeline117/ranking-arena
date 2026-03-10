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

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Platform configs with limits per period
const PLATFORM_LIMITS: Record<string, { limit90: number; limit30: number; limit7: number }> = {
  binance_futures: { limit90: 200, limit30: 150, limit7: 100 },
  binance_spot: { limit90: 100, limit30: 80, limit7: 50 },
  bybit: { limit90: 200, limit30: 150, limit7: 100 },
  bybit_spot: { limit90: 80, limit30: 60, limit7: 40 },
  okx_futures: { limit90: 80, limit30: 80, limit7: 60 },
  bitget_futures: { limit90: 60, limit30: 60, limit7: 50 },
  bitget_spot: { limit90: 40, limit30: 40, limit7: 30 },
  hyperliquid: { limit90: 100, limit30: 80, limit7: 60 },
  gmx: { limit90: 60, limit30: 50, limit7: 40 },
  htx_futures: { limit90: 40, limit30: 40, limit7: 30 },
  gateio: { limit90: 60, limit30: 50, limit7: 40 },
  mexc: { limit90: 60, limit30: 50, limit7: 40 },
  drift: { limit90: 60, limit30: 50, limit7: 40 },
  dydx: { limit90: 80, limit30: 60, limit7: 40 },
  aevo: { limit90: 60, limit30: 50, limit7: 40 },
  gains: { limit90: 60, limit30: 50, limit7: 40 },
  kwenta: { limit90: 60, limit30: 50, limit7: 40 },
  jupiter_perps: { limit90: 80, limit30: 60, limit7: 40 },
}

// High priority platforms (always enriched)
const HIGH_PRIORITY = ['binance_futures', 'bybit', 'okx_futures', 'bitget_futures', 'hyperliquid', 'gmx', 'dydx', 'jupiter_perps']

// Medium priority (enriched with all=true or period=90D)
const MEDIUM_PRIORITY = ['binance_spot', 'bybit_spot', 'htx_futures', 'gateio', 'mexc', 'drift', 'aevo', 'gains', 'kwenta']

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
  let platforms: string[]
  if (enrichAll) {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY]
  } else {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY]
  }

  const results: BatchResult[] = []
  const plog = await PipelineLogger.start(`batch-enrich-${periodParam}`, { period: periodParam, enrichAll, platforms })

  // Safety timeout: ensure plog gets called before Vercel kills the function at 300s
  const SAFETY_TIMEOUT_MS = 280_000
  const safetyTimer = setTimeout(async () => {
    try {
      await plog.error(new Error('Safety timeout: function approaching 300s limit'), { results })
    } catch { /* best effort */ }
  }, SAFETY_TIMEOUT_MS)

  // Per-platform enrichment timeout
  // okx/bitget/htx need 100s+ for 90D (high trader count × slow concurrency × delay)
  const ENRICH_TIMEOUT_MS = periodsToRun.length > 1 ? 60_000 : 120_000

  const functionStart = Date.now()
  // Budget per period: divide 270s (leaving 30s buffer) by number of periods
  const PER_PERIOD_BUDGET_MS = Math.floor(270_000 / periodsToRun.length)

  // Run each period sequentially (when period=all, this runs 90D → 30D → 7D)
  for (const period of periodsToRun) {
    // Bail early if we're running low on time (leave 30s for cleanup/logging)
    const elapsed = Date.now() - functionStart
    if (elapsed > 250_000) {
      results.push({ platform: '*', period, status: 'error', durationMs: 0, error: `Skipped: ${Math.round(elapsed / 1000)}s elapsed, <50s remaining` })
      continue
    }

    const periodStart = Date.now()

    // Run enrichments inline in parallel batches of 5
    // With 9 platforms: 2 batches × ~120s = ~240s (within 270s budget)
    const BATCH_CONCURRENCY = 5
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
      const batchResults = await Promise.all(
        batch.map(async (platform): Promise<BatchResult> => {
          const config = PLATFORM_LIMITS[platform]
          if (!config) return { platform, period, status: 'error', durationMs: 0, error: 'No config' }

          const limit = period === '90D' ? config.limit90 : period === '30D' ? config.limit30 : config.limit7
          const start = Date.now()

          try {
            // Wrap enrichment in a timeout to prevent stuck jobs
            const result: EnrichmentResult = await Promise.race([
              runEnrichment({ platform, period, limit }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Enrichment ${platform}/${period} timed out after ${ENRICH_TIMEOUT_MS / 1000}s`)), ENRICH_TIMEOUT_MS)
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
      results.push(...batchResults)
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
