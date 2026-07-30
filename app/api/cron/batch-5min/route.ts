/**
 * Batch dispatcher for all "every 5 minutes" cron jobs.
 *
 * Runs sub-jobs INLINE (in-process) to avoid:
 * - Cloudflare 100s proxy timeout (via NEXT_PUBLIC_APP_URL)
 * - Vercel deployment protection 401 (via VERCEL_URL)
 *
 * Sub-jobs:
 * - refresh-hot-scores: Update post hot_score via RPC
 *
 * First-party trader sync is intentionally NOT run here. It belongs to the
 * BullMQ ingest worker, which owns scheduling, retries, and first-party writes.
 *
 * Schedule: every 5 min (see vercel.json)
 *
 * Resilience (2026-04-07):
 * - AbortController cancels the database request before releasing the cron lock
 * - The sub-job timeout is cleared on every completion path
 * - Logs which sub-job is slow for easier diagnosis
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { refreshHotScoresInline, type InlineJobResult } from '@/lib/cron/inline-jobs'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Vercel ceiling; the mutation budget below is 90s

const logger = createLogger('batch-5min')

/** Wrap a sub-job with a per-job timeout so one slow job doesn't block the batch.
 *  Also logs when a timeout fires so we know which sub-job was slow. */
function withTimeout(
  fn: (signal: AbortSignal) => Promise<InlineJobResult>,
  jobName: string,
  timeoutMs: number = 120_000 // 2 min per sub-job
): Promise<InlineJobResult> {
  const jobStart = Date.now()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const operation = fn(controller.signal).then((result) => {
    const elapsed = Date.now() - jobStart
    if (elapsed > 60_000) {
      logger.warn(`[${jobName}] completed but took ${Math.round(elapsed / 1000)}s (>60s threshold)`)
    }
    return result
  })
  const deadline = new Promise<InlineJobResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort(new Error(`${jobName} timed out`))
      logger.error(
        `[${jobName}] TIMED OUT after ${Math.round(timeoutMs / 1000)}s — request aborted`
      )
      resolve({
        name: jobName,
        status: 'error',
        durationMs: timeoutMs,
        detail: { timedOut: true },
        error: `${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)
  })

  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

export async function GET(request: NextRequest) {
  // Verify cron secret (timing-safe)
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const lock = await acquireCronLock('batch-5min', { ttlSeconds: 300 })
  if (lock.status !== 'acquired') {
    return NextResponse.json(
      lock.status === 'contended'
        ? { ok: true, status: 'skipped', reason: 'already running' }
        : { ok: false, status: 'error', reason: 'lock_unavailable' },
      { status: lock.status === 'contended' ? 200 : 503 }
    )
  }
  const releaseLock = lock.release

  const startTime = Date.now()

  // The legacy refresh_jobs worker was retired: its DISCOVER/SNAPSHOT paths no
  // longer publish ranking data, yet still acknowledged jobs as completed.
  // First-party trader collection belongs exclusively to the ingest worker.
  const PER_JOB_TIMEOUT_MS = 90_000

  let results: InlineJobResult[]
  try {
    const plog = await PipelineLogger.start('batch-5min')
    try {
      results = [
        await withTimeout(refreshHotScoresInline, 'refresh-hot-scores', PER_JOB_TIMEOUT_MS),
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
      await plog.error(
        new Error(`batch-5min mutation timeout after ${Math.round(totalDuration / 1000)}s`),
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
        status: timedOut ? 504 : failedJobs.length > 0 ? 500 : 200,
      }
    )
  } finally {
    await releaseLock()
  }
}
