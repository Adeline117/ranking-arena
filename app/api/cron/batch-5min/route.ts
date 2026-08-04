/**
 * Batch dispatcher for all "every 5 minutes" cron jobs.
 *
 * Runs the job INLINE (in-process) to avoid:
 * - Cloudflare 100s proxy timeout (via NEXT_PUBLIC_APP_URL)
 * - Vercel deployment protection 401 (via VERCEL_URL)
 *
 * Sub-job:
 * - refresh-hot-scores: Update post hot_score via RPC
 *
 * First-party trader sync is intentionally NOT run here. It belongs to the
 * BullMQ ingest worker, which owns exchange fetching, retries, and canonical
 * data writes. Retired legacy queue consumption must not run in Vercel.
 *
 * Historical route name retained for compatibility. Production schedule:
 * every 15 minutes (see vercel.json).
 *
 * Resilience (2026-04-07):
 * - The job gets a 90-second abortable deadline
 * - Slow execution is logged for diagnosis
 * - Pipeline and HTTP timeout states remain consistent
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { refreshHotScoresInline, type InlineJobResult } from '@/lib/cron/inline-jobs'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import { withAbortableTimeout } from '@/lib/utils/timeout'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Vercel ceiling; internal deadlines return earlier

const logger = createLogger('batch-5min')

/** Wrap a job with the shared timeout primitive, which clears its timer when
 *  the operation wins the race. */
async function runWithTimeout(
  fn: (signal: AbortSignal) => Promise<InlineJobResult>,
  jobName: string,
  timeoutMs: number
): Promise<InlineJobResult> {
  const jobStart = Date.now()
  try {
    const result = await withAbortableTimeout(fn, timeoutMs, jobName)
    const elapsed = Date.now() - jobStart
    if (elapsed > 60_000) {
      logger.warn(`[${jobName}] completed but took ${Math.round(elapsed / 1000)}s (>60s threshold)`)
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = message.startsWith(`Timeout: ${jobName}`)
    if (timedOut) {
      logger.error(`[${jobName}] TIMED OUT after ${Math.round(timeoutMs / 1000)}s`)
    }
    return {
      name: jobName,
      status: 'error',
      durationMs: Date.now() - jobStart,
      error: message,
      detail: { timedOut },
    }
  }
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

  // Per-job timeout: 90s.
  const PER_JOB_TIMEOUT_MS = 90_000

  // Keep the result array shape used by PipelineLogger and the response contract.
  let results: InlineJobResult[]
  try {
    try {
      results = [
        await runWithTimeout(refreshHotScoresInline, 'refresh-hot-scores', PER_JOB_TIMEOUT_MS),
      ]
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
    const timedOut = failedJobs.some((result) => result.detail?.timedOut === true)

    // Log timing for each sub-job for diagnosis
    for (const r of results) {
      logger.info(
        `[${r.name}] status=${r.status} duration=${Math.round(r.durationMs / 1000)}s${r.error ? ` error=${r.error}` : ''}`
      )
    }

    if (timedOut) {
      await plog.timeout({ results, totalDurationMs: totalDuration })
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
        status: timedOut ? 'timeout' : failedJobs.length > 0 ? 'error' : 'success',
        totalDurationMs: totalDuration,
        results,
      },
      {
        status: timedOut ? 504 : failedJobs.length > 0 ? 500 : 200,
      }
    )
  } finally {
    await releaseLock()
  }
}
