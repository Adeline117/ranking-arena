/**
 * Dedicated GMX enrichment endpoint (DEPRECATED)
 *
 * NOT scheduled in vercel.json — GMX enrichment now handled by batch-enrich.
 * Kept for manual re-enrichment if needed.
 *
 * GMX requires >360s to enrich 500 traders for 90D period,
 * so it was originally split from batch-enrich to avoid timeout issues.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { runEnrichment } from '@/lib/cron/enrichment-runner'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 600 // Vercel Pro max: 10 minutes

const GMX_LIMITS = {
  limit90: 100, // Reduced from 150 for stability with lower concurrency
  limit30: 80,
  limit7: 60,
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('enrich-gmx-all')

  interface PeriodResult {
    period: string
    status: 'success' | 'error'
    durationMs?: number
    enriched?: number
    failed?: number
    error?: string
  }

  const results: PeriodResult[] = []
  const periods = ['90D', '30D', '7D'] as const

  // Safety timeout at 580s (leaving 20s buffer from 600s limit)
  const SAFETY_TIMEOUT_MS = 580_000
  const safetyTimer = setTimeout(async () => {
    try {
      await plog.error(new Error('Safety timeout: function approaching 600s limit'), { results })
    } catch { /* best effort */ }
  }, SAFETY_TIMEOUT_MS)

  const functionStart = Date.now()

  for (const period of periods) {
    // Bail if we're low on time
    const elapsed = Date.now() - functionStart
    if (elapsed > 550_000) {
      results.push({
        period,
        status: 'error',
        error: `Skipped: ${Math.round(elapsed / 1000)}s elapsed, <50s remaining`,
      })
      continue
    }

    const limit = period === '90D' ? GMX_LIMITS.limit90 : period === '30D' ? GMX_LIMITS.limit30 : GMX_LIMITS.limit7
    const start = Date.now()

    try {
      const result = await runEnrichment({ platform: 'gmx', period, limit })
      results.push({
        period,
        status: result.ok ? 'success' : 'error',
        durationMs: Date.now() - start,
        enriched: result.summary.enriched,
        failed: result.summary.failed,
        error: result.ok ? undefined : `${result.summary.failed} enrichments failed`,
      })
    } catch (err) {
      results.push({
        period,
        status: 'error',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  clearTimeout(safetyTimer)

  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.length - succeeded

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else {
    await plog.error(new Error(`${failed}/${results.length} periods failed`), { results })
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    platform: 'gmx',
    periods: results.length,
    succeeded,
    failed,
    results,
  })
}
