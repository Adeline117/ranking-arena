/**
 * withCron — Standard wrapper for all cron job routes.
 *
 * Eliminates ~30 lines of boilerplate per cron route:
 * - CRON_SECRET auth verification
 * - PipelineLogger lifecycle (start/success/error/timeout)
 * - Safety timeout before Vercel kills the function
 * - Structured error handling
 *
 * V1 source currently authenticates and returns a fixed retirement response
 * before any of this execution machinery can run. This wrapper remains as the
 * reviewed historical implementation for a separately approved reopening.
 *
 * Usage:
 *   export const GET = withCron('batch-fetch-traders-a', async (request, { plog, supabase }) => {
 *     const count = await doWork(supabase)
 *     return { traders_fetched: count }
 *   })
 *
 * Inspired by dub.co's withCron pattern (23K★).
 */

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { getOrCreateCorrelationId, runWithCorrelationId } from '@/lib/api/correlation'
import { v1CronExecutionGate } from '@/lib/cron/v1-execution-publication'
import * as Sentry from '@sentry/nextjs'

interface CronContext {
  plog: PipelineLogHandle
  supabase: SupabaseClient<Database>
}

interface CronOptions {
  /**
   * The route's own `export const maxDuration` (seconds). The safety timeout
   * and lock TTL are derived from it so the timeout fires BEFORE Vercel kills
   * the function (2026-11 audit P2-3: a fixed 580s default never fired for
   * 30-300s routes, leaving pipeline_logs stuck in `running`). Default 60.
   */
  maxDurationSec?: number
  /** Explicit safety timeout (ms); must be below the route's maxDuration. */
  safetyTimeoutMs?: number
  /** Initial metadata to log with PipelineLogger */
  metadata?: Record<string, unknown>
}

type CronHandler = (
  request: NextRequest,
  ctx: CronContext
) => Promise<{ count?: number; [key: string]: unknown }>

/**
 * Wrap a cron job handler with auth, logging, and safety timeout.
 */
const DEFAULT_MAX_DURATION_SEC = 60

/** Safety timeout = maxDuration minus a margin (10%, at least 5s) so the
 *  timeout log is written while the function is still alive. */
export function deriveSafetyTimeoutMs(maxDurationSec: number): number {
  const maxMs = Math.max(1, maxDurationSec) * 1000
  const margin = Math.max(5_000, Math.round(maxMs * 0.1))
  return Math.max(1_000, maxMs - margin)
}

/** Compare-and-delete: only the holder of `token` may release the lock, so a
 *  run that outlived its TTL cannot delete the next run's lock. */
const RELEASE_LOCK_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`

export function withCron(jobName: string, handler: CronHandler, options: CronOptions = {}) {
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC
  const safetyTimeoutMs = options.safetyTimeoutMs ?? deriveSafetyTimeoutMs(maxDurationSec)

  return async (request: NextRequest) => {
    // 1. Authenticate first, then stop V1-held automation before correlation,
    // locks, PipelineLogger, Supabase, Redis, or a route handler can run.
    const v1Gate = v1CronExecutionGate(request)
    if (v1Gate) return v1Gate

    // 1.5. Bind a correlation ID for this cron run. Uses any upstream
    // X-Correlation-ID / X-Request-ID header so Vercel/OpenClaw can thread
    // IDs end-to-end; otherwise generates a fresh one. All logs inside
    // `handler` (including async continuations like fireAndForget) will
    // automatically include [cid:<id>] so a single cron run can be reassembled
    // from log aggregator output.
    const correlationId = getOrCreateCorrelationId(request)
    return runWithCorrelationId(correlationId, () => runCron(request, correlationId))
  }

  async function runCron(request: NextRequest, correlationId: string): Promise<NextResponse> {
    // 2. Distributed lock — prevent concurrent execution of the same cron job
    const lockKey = `cron:lock:${jobName}`
    // The lock must outlive the function (killed at maxDuration) by a small
    // margin, then expire on its own if `finally` never ran.
    const lockTtlSec = Math.ceil(Math.max(maxDurationSec * 1000, safetyTimeoutMs) / 1000) + 30
    const lockToken = `${Date.now()}:${Math.random().toString(36).slice(2, 12)}`
    let redis: Awaited<ReturnType<typeof getSharedRedis>> = null
    let lockAcquired = false
    try {
      redis = await getSharedRedis()
      if (redis) {
        // SET NX with EX — atomic acquire
        const result = await redis.set(lockKey, lockToken, { nx: true, ex: lockTtlSec })
        if (result === 'OK') {
          lockAcquired = true
        } else {
          // Another instance already holds the lock
          logger.info(`[${jobName}] Skipped — concurrent execution (lock held)`)
          const skipRes = NextResponse.json(
            { ok: true, skipped: true, reason: 'concurrent execution' },
            { status: 200 }
          )
          skipRes.headers.set('X-Correlation-ID', correlationId)
          return skipRes
        }
      }
      // If redis is null, proceed without lock (fail-open)
    } catch (lockErr) {
      // Redis error — proceed without lock (fail-open for locks is correct)
      logger.warn(`[${jobName}] Redis lock failed, proceeding without lock:`, lockErr)
    }

    Sentry.setTag('cron', jobName)

    // 3. Extract metadata from search params
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries())
    const metadata = { ...options.metadata, ...searchParams }

    // 4. Start pipeline logger. Correlation ID is stored in metadata so it
    // becomes queryable via pipeline_logs (→ ClickHouse dual-write), allowing
    // operators to find every log line for a given cron run with one query.
    const plog = await PipelineLogger.start(jobName, { ...metadata, correlationId })
    const supabase = getSupabaseAdmin()

    // 5. Safety timeout
    let safetyFired = false
    const safetyTimer = setTimeout(async () => {
      safetyFired = true
      try {
        await plog.timeout({ reason: 'safety_timeout', safetyTimeoutMs })
        logger.error(`[${jobName}] Safety timeout fired at ${safetyTimeoutMs}ms`)
      } catch (_err) {
        /* best effort - Telegram/Sentry alert */
      }
    }, safetyTimeoutMs)

    // 6. Execute handler
    const startTime = Date.now()
    try {
      const result = await handler(request, { plog, supabase })
      clearTimeout(safetyTimer)

      if (safetyFired) {
        // Safety already logged timeout — don't overwrite
        const timeoutRes = NextResponse.json({
          ok: false,
          error: 'safety_timeout',
          partial: result,
        })
        timeoutRes.headers.set('X-Correlation-ID', correlationId)
        return timeoutRes
      }

      const elapsed = Date.now() - startTime
      await plog.success(result.count ?? 0, { ...result, elapsed_ms: elapsed })

      const res = NextResponse.json({ ok: true, elapsed_ms: elapsed, ...result })
      res.headers.set('X-Correlation-ID', correlationId)
      return res
    } catch (err: unknown) {
      clearTimeout(safetyTimer)
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`[${jobName}] Cron error:`, err)

      if (!safetyFired) {
        await plog.error(err instanceof Error ? err : new Error(errorMessage), {
          elapsed_ms: Date.now() - startTime,
        })
      }

      const errRes = NextResponse.json(
        { ok: false, error: errorMessage, elapsed_ms: Date.now() - startTime },
        { status: 500 }
      )
      errRes.headers.set('X-Correlation-ID', correlationId)
      return errRes
    } finally {
      // Release the distributed lock
      if (lockAcquired && redis) {
        try {
          await redis.eval(RELEASE_LOCK_IF_OWNER, [lockKey], [lockToken])
        } catch (unlockErr) {
          logger.warn(`[${jobName}] Failed to release lock:`, unlockErr)
        }
      }
    }
  }
}
