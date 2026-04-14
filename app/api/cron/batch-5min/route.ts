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
 *
 * Resilience (2026-04-07):
 * - Global AbortController ensures the response is sent before maxDuration
 * - Each sub-job gets its own timeout via Promise.race
 * - Logs which sub-job is slow for easier diagnosis
 * - Reduced global timeout from 280s to 240s for extra safety margin
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
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes — longest of the three

const logger = createLogger('batch-5min')

/** Wrap a sub-job with a per-job timeout so one slow job doesn't block the batch.
 *  Also logs when a timeout fires so we know which sub-job was slow. */
function withTimeout(
  fn: () => Promise<InlineJobResult>,
  jobName: string,
  timeoutMs: number = 120_000, // 2 min per sub-job
): Promise<InlineJobResult> {
  const jobStart = Date.now()
  return Promise.race([
    fn().then((result) => {
      const elapsed = Date.now() - jobStart
      if (elapsed > 60_000) {
        logger.warn(`[${jobName}] completed but took ${Math.round(elapsed / 1000)}s (>60s threshold)`)
      }
      return result
    }),
    new Promise<InlineJobResult>((resolve) =>
      setTimeout(() => {
        logger.error(`[${jobName}] TIMED OUT after ${Math.round(timeoutMs / 1000)}s — this sub-job is hanging`)
        resolve({
          name: jobName,
          status: 'error',
          durationMs: timeoutMs,
          error: `${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`,
        })
      }, timeoutMs)
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

  // Global safety timeout: 240s (leaves 60s buffer before Vercel's 300s maxDuration kills us)
  // This ensures we ALWAYS send a response and log results, even if sub-jobs are slow.
  const GLOBAL_TIMEOUT_MS = 240_000
  // Per sub-job timeout: 90s each (3 jobs × 90s = 270s max, but they run in parallel so 90s wall clock)
  const PER_JOB_TIMEOUT_MS = 90_000

  // Run all sub-jobs in parallel with per-job timeouts.
  // Global timeout ensures we return a response even if Promise.race somehow hangs.
  let results: InlineJobResult[]
  let timedOut = false
  try {
    results = await Promise.race([
      Promise.all([
        withTimeout(runWorkerInline, 'run-worker', PER_JOB_TIMEOUT_MS),
        withTimeout(refreshHotScoresInline, 'refresh-hot-scores', PER_JOB_TIMEOUT_MS),
        withTimeout(syncTradersInline, 'trader-sync', PER_JOB_TIMEOUT_MS),
      ]),
      new Promise<InlineJobResult[]>((resolve) =>
        setTimeout(() => {
          logger.error(`batch-5min global timeout after ${GLOBAL_TIMEOUT_MS / 1000}s — returning partial results`)
          timedOut = true
          // Return timeout results for all jobs so we still log something useful
          resolve([
            { name: 'run-worker', status: 'error', durationMs: GLOBAL_TIMEOUT_MS, error: 'global timeout' },
            { name: 'refresh-hot-scores', status: 'error', durationMs: GLOBAL_TIMEOUT_MS, error: 'global timeout' },
            { name: 'trader-sync', status: 'error', durationMs: GLOBAL_TIMEOUT_MS, error: 'global timeout' },
          ])
        }, GLOBAL_TIMEOUT_MS)
      ),
    ])
  } catch (err) {
    const totalDuration = Date.now() - startTime
    logger.error(`batch-5min unexpected error after ${Math.round(totalDuration / 1000)}s: ${String(err)}`)
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ batch: 'batch-5min', status: 'error', error: String(err), totalDurationMs: totalDuration }, { status: 500 })
  }

  const totalDuration = Date.now() - startTime
  const failedJobs = results.filter(r => r.status === 'error')
  const succeeded = results.filter(r => r.status === 'success').length

  // Log timing for each sub-job for diagnosis
  for (const r of results) {
    logger.info(`[${r.name}] status=${r.status} duration=${Math.round(r.durationMs / 1000)}s${r.error ? ` error=${r.error}` : ''}`)
  }

  // Only log as error if a critical sub-job (not run-worker) fails.
  // run-worker timeout is expected when processing a backlog — it'll catch up next run.
  const criticalFailures = failedJobs.filter(r => r.name !== 'run-worker')
  if (timedOut) {
    await plog.error(new Error(`batch-5min global timeout after ${Math.round(totalDuration / 1000)}s`), { results, totalDurationMs: totalDuration })
  } else if (criticalFailures.length > 0) {
    await plog.error(new Error(`${failedJobs.length}/${results.length} sub-jobs failed`), { results })
  } else {
    await plog.success(succeeded, { results })
  }

  return NextResponse.json({
    batch: 'batch-5min',
    status: timedOut ? 'timeout' : (failedJobs.length > 0 ? 'partial' : 'success'),
    totalDurationMs: totalDuration,
    results,
  }, {
    status: timedOut ? 504 : (failedJobs.length > 0 ? 207 : 200),
  })
}
