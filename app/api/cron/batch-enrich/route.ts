/**
 * Batch enrich dispatcher
 *
 * Calls enrichment logic INLINE (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   period=90D|30D|7D (default: 90D) - which time period to enrich
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
  okx_futures: { limit90: 150, limit30: 120, limit7: 80 },
  bitget_futures: { limit90: 150, limit30: 120, limit7: 80 },
  bitget_spot: { limit90: 80, limit30: 60, limit7: 40 },
  hyperliquid: { limit90: 120, limit30: 100, limit7: 60 },
  gmx: { limit90: 100, limit30: 80, limit7: 50 },
  mexc: { limit90: 80, limit30: 60, limit7: 40 },
  htx_futures: { limit90: 80, limit30: 60, limit7: 40 },
  kucoin: { limit90: 60, limit30: 50, limit7: 30 },
  dydx: { limit90: 80, limit30: 60, limit7: 40 },
  gains: { limit90: 60, limit30: 50, limit7: 30 },
  jupiter_perps: { limit90: 60, limit30: 50, limit7: 30 },
  aevo: { limit90: 60, limit30: 50, limit7: 30 },
  kwenta: { limit90: 60, limit30: 50, limit7: 30 },
  synthetix: { limit90: 60, limit30: 50, limit7: 30 },
  mux: { limit90: 40, limit30: 30, limit7: 20 },
}

// High priority platforms (always enriched)
const HIGH_PRIORITY = ['binance_futures', 'bybit', 'okx_futures', 'bitget_futures', 'hyperliquid', 'gmx']

// Medium priority (enriched with all=true or period=90D)
const MEDIUM_PRIORITY = ['binance_spot', 'bybit_spot', 'bitget_spot', 'mexc', 'htx_futures', 'dydx', 'gains', 'aevo']

// Lower priority (enriched only with all=true)
const LOWER_PRIORITY = ['kucoin', 'jupiter_perps', 'kwenta', 'synthetix', 'mux']

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

  const period = request.nextUrl.searchParams.get('period') || '90D'
  const enrichAll = request.nextUrl.searchParams.get('all') === 'true'

  if (!['7D', '30D', '90D'].includes(period)) {
    return NextResponse.json({ error: 'Invalid period, must be 7D, 30D, or 90D' }, { status: 400 })
  }

  // Determine which platforms to enrich
  let platforms: string[]
  if (enrichAll) {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY]
  } else {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY]
  }

  const results: BatchResult[] = []
  const plog = await PipelineLogger.start(`batch-enrich-${period}`, { period, enrichAll, platforms })

  // Run enrichments inline in parallel batches of 3
  const BATCH_CONCURRENCY = 3
  for (let i = 0; i < platforms.length; i += BATCH_CONCURRENCY) {
    const batch = platforms.slice(i, i + BATCH_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (platform): Promise<BatchResult> => {
        const config = PLATFORM_LIMITS[platform]
        if (!config) return { platform, period, status: 'error', durationMs: 0, error: 'No config' }

        const limit = period === '90D' ? config.limit90 : period === '30D' ? config.limit30 : config.limit7
        const start = Date.now()

        try {
          const result: EnrichmentResult = await runEnrichment({ platform, period, limit })
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
    period,
    platforms: platforms.length,
    succeeded,
    failed,
    results,
  })
}
