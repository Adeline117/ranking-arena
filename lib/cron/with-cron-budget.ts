/**
 * withCronBudget — unified cron execution wrapper.
 *
 * Consolidates the boilerplate that currently lives in every cron route:
 *   1. CRON_SECRET auth check
 *   2. Redis atomic idempotency lock (SET NX EX)
 *   3. PipelineLogger lifecycle (start → success/error)
 *   4. Time budget accounting (remainingMs, deadline)
 *   5. Double-finalization guard (only one of success/error fires)
 *   6. Lock release in finally
 *
 * Retro 2026-04-09 found 94 commits across 8+ files were all patching the
 * same timeout / safety-timer / double-finalization pattern. This helper is
 * the single place that pattern lives.
 *
 * Usage:
 *   export async function GET(request: NextRequest) {
 *     return withCronBudget(
 *       {
 *         jobName: 'my-cron',
 *         lockKey: 'cron:my-cron:running',
 *         maxDurationSec: 300,
 *         safetyMarginSec: 30,
 *         request,
 *       },
 *       async ({ remainingMs, plog }) => {
 *         const rows = await doWork()
 *         if (remainingMs() < 30_000) {
 *           return { status: 'partial_success', recordsProcessed: rows.length, note: 'skipped post-processing' }
 *         }
 *         await postProcess()
 *         return { recordsProcessed: rows.length }
 *       },
 *     )
 *   }
 *
 * Existing crons can adopt this incrementally. Not a forced migration.
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { logger } from '@/lib/utils/logger'
import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'

export interface CronBudgetOptions {
  /** Cron job name for pipeline_logs (e.g. 'compute-leaderboard-90D') */
  jobName: string
  /**
   * Redis idempotency key. If set, a Redis SET NX EX lock is acquired before
   * the callback runs. If the lock is already held, the wrapper returns early
   * with `{ ok: true, cached: true }` and the callback is skipped.
   * If unset, no locking is performed (useful for crons where reentrance is safe).
   */
  lockKey?: string
  /** Lock TTL seconds (default 300). Must be >= maxDurationSec. */
  lockTtlSec?: number
  /** Vercel function maxDuration for this cron in seconds. */
  maxDurationSec: number
  /**
   * Reserve this many seconds at the end for finalization / post-processing.
   * `remainingMs()` treats this as the effective deadline.
   * Default 20s.
   */
  safetyMarginSec?: number
  /**
   * NextRequest for CRON_SECRET header auth. Omit to skip auth (useful for
   * internal invocations from worker/).
   */
  request?: NextRequest
  /** Skip the CRON_SECRET header check entirely (for tests or internal use). */
  skipAuth?: boolean
  /** Metadata forwarded to PipelineLogger.start. */
  metadata?: Record<string, unknown>
}

export interface CronBudgetContext {
  /** Milliseconds remaining before the effective deadline. */
  remainingMs: () => number
  /** Absolute effective deadline (epoch ms). */
  deadline: number
  /** PipelineLogger handle — call partialSuccess() etc. directly if needed. */
  plog: PipelineLogHandle
  /** Wall-clock start time (epoch ms). */
  startTime: number
  /** True if <safetyMargin ms remain (time is running out). */
  timeIsTight: () => boolean
}

export interface CronBudgetSuccess {
  /** Records processed (passed to plog.success). */
  recordsProcessed?: number
  /** Extra metadata merged into plog.success. */
  metadata?: Record<string, unknown>
  /** If 'partial_success', plog.partialSuccess is called instead. */
  status?: 'success' | 'partial_success'
  /** For partial_success: list of failed item identifiers. */
  failedItems?: string[]
  /** Extra fields returned in the HTTP response body. */
  body?: Record<string, unknown>
}

function authorize(request: NextRequest | undefined): NextResponse | null {
  if (!request) return null
  if (!env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }
  const { verifyCronSecret } = require('@/lib/auth/verify-service-auth')
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

async function acquireLock(lockKey: string, ttlSec: number): Promise<boolean> {
  try {
    const { getSharedRedis } = await import('@/lib/cache/redis-client')
    const redis = await getSharedRedis()
    if (!redis) {
      // No Redis — proceed without lock. Callers that *require* idempotency
      // should check `ctx.remainingMs` and defend themselves accordingly.
      return true
    }
    const result = await redis.set(lockKey, new Date().toISOString(), { nx: true, ex: ttlSec })
    return result === 'OK'
  } catch (err) {
    logger.warn(`[withCronBudget] Redis lock acquisition failed, proceeding without lock: ${err instanceof Error ? err.message : String(err)}`)
    return true
  }
}

async function releaseLock(lockKey: string): Promise<void> {
  try {
    const { getSharedRedis } = await import('@/lib/cache/redis-client')
    const redis = await getSharedRedis()
    if (redis) await redis.del(lockKey)
  } catch (err) {
    // Lock auto-expires via TTL — release failure is non-fatal.
    logger.warn(`[withCronBudget] Redis lock release failed (will auto-expire): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Main wrapper. Returns a NextResponse that the cron route handler can return
 * directly.
 */
export async function withCronBudget(
  opts: CronBudgetOptions,
  fn: (ctx: CronBudgetContext) => Promise<CronBudgetSuccess | void>,
): Promise<NextResponse> {
  // 1. Auth
  if (!opts.skipAuth) {
    const authErr = authorize(opts.request)
    if (authErr) return authErr
  }

  // 2. Idempotency lock (optional)
  const lockKey = opts.lockKey
  const lockTtl = opts.lockTtlSec ?? 300
  if (lockKey) {
    const acquired = await acquireLock(lockKey, lockTtl)
    if (!acquired) {
      return NextResponse.json({
        ok: true,
        message: `Already running (atomic lock: ${lockKey})`,
        cached: true,
      })
    }
  }

  // 3. PipelineLogger + time budget setup
  const startTime = Date.now()
  const safetyMarginSec = opts.safetyMarginSec ?? 20
  const effectiveBudgetMs = (opts.maxDurationSec - safetyMarginSec) * 1000
  const deadline = startTime + effectiveBudgetMs
  const remainingMs = () => deadline - Date.now()
  const timeIsTight = () => remainingMs() < 0

  const plog = await PipelineLogger.start(opts.jobName, opts.metadata)

  // Guard against double finalization — once the plog has been closed (by
  // success / partialSuccess / error / timeout), further calls are no-ops.
  let finalized = false
  const finalizeSuccess = async (result: CronBudgetSuccess | void) => {
    if (finalized) return
    finalized = true
    const records = result?.recordsProcessed ?? 0
    const meta = result?.metadata
    if (result?.status === 'partial_success') {
      await plog.partialSuccess(records, result.failedItems ?? [], meta)
    } else {
      await plog.success(records, meta)
    }
  }
  const finalizeError = async (err: unknown) => {
    if (finalized) return
    finalized = true
    await plog.error(err)
  }

  // 4. Run the callback with cleanup guaranteed
  try {
    const result = await fn({
      remainingMs,
      deadline,
      plog,
      startTime,
      timeIsTight,
    })

    await finalizeSuccess(result ?? undefined)

    const elapsedMs = Date.now() - startTime
    return NextResponse.json({
      ok: true,
      job: opts.jobName,
      elapsed_ms: elapsedMs,
      records: result?.recordsProcessed ?? 0,
      ...(result?.body ?? {}),
    })
  } catch (err) {
    await finalizeError(err)
    logger.error(`[${opts.jobName}] failed:`, err)
    return NextResponse.json(
      {
        ok: false,
        job: opts.jobName,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  } finally {
    if (lockKey) {
      // Await the lock release with a 2s safety timeout. A single Redis DEL
      // is normally <10ms; TTL (opts.lockTtlSec) is the auto-expire fallback
      // if the release call hangs.
      await Promise.race([
        releaseLock(lockKey),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ])
    }
  }
}
