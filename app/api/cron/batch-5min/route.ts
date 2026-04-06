/**
 * Batch dispatcher for all "every 5 minutes" cron jobs.
 *
 * Runs sub-jobs INLINE (in-process) to avoid:
 * - Cloudflare 100s proxy timeout (via NEXT_PUBLIC_APP_URL)
 * - Vercel deployment protection 401 (via VERCEL_URL)
 *
 * Sub-jobs:
 * - run-worker: Process pending refresh_jobs
 * - refresh-hot-scores: Update post hot_score via RPC
 * - trader-sync: Sync authorized trader data from exchanges
 *
 * Schedule: every 5 min (see vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import {
  runWorkerInline,
  refreshHotScoresInline,
  syncTradersInline,
  type InlineJobResult,
} from '@/lib/cron/inline-jobs'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes — longest of the three

/** Wrap a sub-job with a per-job timeout so one slow job doesn't block the batch */
function withTimeout(
  fn: () => Promise<InlineJobResult>,
  jobName: string,
  timeoutMs: number = 120_000, // 2 min per sub-job
): Promise<InlineJobResult> {
  return Promise.race([
    fn(),
    new Promise<InlineJobResult>((resolve) =>
      setTimeout(() => resolve({
        name: jobName,
        status: 'error',
        durationMs: timeoutMs,
        error: `${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`,
      }), timeoutMs)
    ),
  ])
}

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (!env.CRON_SECRET) {
    if (process.env.NODE_ENV !== 'development') {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
    }
  } else if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const plog = await PipelineLogger.start('batch-5min')

  // Run all sub-jobs in parallel with per-job timeouts (120s each).
  // This prevents a single slow job from consuming the entire 300s budget.
  let results: InlineJobResult[]
  try {
    results = await Promise.race([
      Promise.all([
        withTimeout(runWorkerInline, 'run-worker', 120_000),
        withTimeout(refreshHotScoresInline, 'refresh-hot-scores', 120_000),
        withTimeout(syncTradersInline, 'trader-sync', 120_000),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('batch-5min timed out after 280s')), 280_000)
      ),
    ])
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ batch: 'batch-5min', status: 'error', error: String(err) }, { status: 500 })
  }

  const totalDuration = Date.now() - startTime
  const failedJobs = results.filter(r => r.status === 'error')
  const succeeded = results.filter(r => r.status === 'success').length
  // Only log as error if a critical sub-job (not run-worker) fails.
  // run-worker timeout is expected when processing a backlog — it'll catch up next run.
  const criticalFailures = failedJobs.filter(r => r.name !== 'run-worker')
  if (criticalFailures.length > 0) {
    await plog.error(new Error(`${failedJobs.length}/${results.length} sub-jobs failed`), { results })
  } else {
    await plog.success(succeeded, { results })
  }

  return NextResponse.json({
    batch: 'batch-5min',
    status: failedJobs.length > 0 ? 'partial' : 'success',
    totalDurationMs: totalDuration,
    results,
  }, {
    status: failedJobs.length > 0 ? 207 : 200,
  })
}
