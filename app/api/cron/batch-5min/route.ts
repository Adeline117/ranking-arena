/**
 * Batch dispatcher for the retained post hot-score maintenance job.
 *
 * Runs the maintenance job INLINE (in-process) to avoid:
 * - Cloudflare 100s proxy timeout (via NEXT_PUBLIC_APP_URL)
 * - Vercel deployment protection 401 (via VERCEL_URL)
 *
 * The legacy `refresh_jobs` consumer was removed during the V1 source hold.
 * Reintroducing source acquisition requires a separately reviewed publisher;
 * this route is deliberately limited to post hot-score maintenance.
 *
 * Resilience (2026-04-07):
 * - Global timeout ensures the response is sent before maxDuration
 * - The job gets its own timeout via Promise.race
 * - Logs a slow job for easier diagnosis
 * - Reduced global timeout from 280s to 240s for extra safety margin
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { refreshHotScoresInline, type InlineJobResult } from '@/lib/cron/inline-jobs'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const logger = createLogger('batch-5min')

/** Keep the maintenance job bounded and log a timeout for diagnosis. */
function withTimeout(
  fn: () => Promise<InlineJobResult>,
  jobName: string,
  timeoutMs: number = 120_000
): Promise<InlineJobResult> {
  const jobStart = Date.now()
  return Promise.race([
    fn().then((result) => {
      const elapsed = Date.now() - jobStart
      if (elapsed > 60_000) {
        logger.warn(
          `[${jobName}] completed but took ${Math.round(elapsed / 1000)}s (>60s threshold)`
        )
      }
      return result
    }),
    new Promise<InlineJobResult>((resolve) =>
      setTimeout(() => {
        logger.error(
          `[${jobName}] TIMED OUT after ${Math.round(timeoutMs / 1000)}s — this sub-job is hanging`
        )
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
  // Verify cron secret (timing-safe)
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('batch-5min', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const startTime = Date.now()
  const plog = await PipelineLogger.start('batch-5min')

  // Global safety timeout: 240s (leaves 60s buffer before Vercel's 300s maxDuration kills us)
  // This ensures we ALWAYS send a response and log results if maintenance is slow.
  const GLOBAL_TIMEOUT_MS = 240_000
  // Per-job timeout: 90 seconds.
  const PER_JOB_TIMEOUT_MS = 90_000

  // Keep the remaining maintenance job bounded even if an RPC hangs.
  let results: InlineJobResult[]
  let timedOut = false
  try {
    try {
      results = await Promise.race([
        Promise.all([
          withTimeout(refreshHotScoresInline, 'refresh-hot-scores', PER_JOB_TIMEOUT_MS),
        ]),
        new Promise<InlineJobResult[]>((resolve) =>
          setTimeout(() => {
            logger.error(
              `batch-5min global timeout after ${GLOBAL_TIMEOUT_MS / 1000}s — returning partial results`
            )
            timedOut = true
            // Return a timeout result so the pipeline log remains diagnostic.
            resolve([
              {
                name: 'refresh-hot-scores',
                status: 'error',
                durationMs: GLOBAL_TIMEOUT_MS,
                error: 'global timeout',
              },
            ])
          }, GLOBAL_TIMEOUT_MS)
        ),
      ])
    } catch (err) {
      const totalDuration = Date.now() - startTime
      logger.error(
        `batch-5min unexpected error after ${Math.round(totalDuration / 1000)}s: ${String(err)}`
      )
      await plog.error(err instanceof Error ? err : new Error(String(err)))
      return NextResponse.json(
        {
          batch: 'batch-5min',
          status: 'error',
          error: String(err),
          totalDurationMs: totalDuration,
        },
        { status: 500 }
      )
    }

    const totalDuration = Date.now() - startTime
    const failedJobs = results.filter((r) => r.status === 'error')
    const succeeded = results.filter((r) => r.status === 'success').length

    // Log timing for the retained job.
    for (const r of results) {
      logger.info(
        `[${r.name}] status=${r.status} duration=${Math.round(r.durationMs / 1000)}s${r.error ? ` error=${r.error}` : ''}`
      )
    }

    if (timedOut) {
      await plog.error(
        new Error(`batch-5min global timeout after ${Math.round(totalDuration / 1000)}s`),
        { results, totalDurationMs: totalDuration }
      )
    } else if (failedJobs.length > 0) {
      await plog.error(new Error(`${failedJobs.length}/${results.length} sub-jobs failed`), {
        results,
      })
    } else {
      await plog.success(succeeded, { results })
    }

    return NextResponse.json(
      {
        batch: 'batch-5min',
        status: timedOut ? 'timeout' : failedJobs.length > 0 ? 'partial' : 'success',
        totalDurationMs: totalDuration,
        results,
      },
      {
        status: timedOut ? 504 : failedJobs.length > 0 ? 207 : 200,
      }
    )
  } finally {
    await releaseLock()
  }
}
