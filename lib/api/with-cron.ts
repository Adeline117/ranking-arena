/**
 * withCron — Standard wrapper for all cron job routes.
 *
 * Eliminates ~30 lines of boilerplate per cron route:
 * - CRON_SECRET auth verification
 * - PipelineLogger lifecycle (start/success/error/timeout)
 * - Safety timeout before Vercel kills the function
 * - Structured error handling
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
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { logger } from '@/lib/logger'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { tryAcquireRedisLease, type RedisLease } from '@/lib/cache/redis-lease'
import { getOrCreateCorrelationId, runWithCorrelationId } from '@/lib/api/correlation'
import * as Sentry from '@sentry/nextjs'

interface CronContext {
  plog: PipelineLogHandle
  supabase: SupabaseClient<Database>
}

interface CronOptions {
  /** Max duration before safety timeout fires (ms). Default: 580_000 (for 600s Vercel limit) */
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
export function withCron(jobName: string, handler: CronHandler, options: CronOptions = {}) {
  const { safetyTimeoutMs = 580_000 } = options

  return async (request: NextRequest) => {
    // 1. Auth verification (timing-safe)
    if (!verifyCronSecret(request)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

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
    // Keep the lease beyond the safety timer so the old invocation cannot
    // overlap a retry while the serverless runtime is still terminating it.
    const lockTtlSec = Math.ceil(safetyTimeoutMs / 1000) + 30
    let lockLease: RedisLease | null = null
    try {
      const redis = await getSharedRedis()
      if (!redis) {
        throw new Error('Redis unavailable')
      }
      lockLease = await tryAcquireRedisLease(redis, lockKey, lockTtlSec)
      if (!lockLease) {
        // Another instance already holds the lock
        logger.info(`[${jobName}] Skipped — concurrent execution (lock held)`)
        const skipRes = NextResponse.json(
          { ok: true, skipped: true, reason: 'concurrent execution' },
          { status: 200 }
        )
        skipRes.headers.set('X-Correlation-ID', correlationId)
        return skipRes
      }
    } catch (lockErr) {
      // Mutating cron jobs must never run concurrently merely because the
      // coordination service is unavailable. A later scheduled run can retry.
      logger.error(`[${jobName}] Redis lock unavailable; cron blocked:`, lockErr)
      const unavailableRes = NextResponse.json(
        { ok: false, skipped: true, reason: 'lock_unavailable' },
        { status: 503 }
      )
      unavailableRes.headers.set('X-Correlation-ID', correlationId)
      return unavailableRes
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
        const timeoutRes = NextResponse.json(
          {
            ok: false,
            error: 'safety_timeout',
            partial: result,
          },
          { status: 504 }
        )
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
      // Release only the lease still owned by this invocation. If its TTL
      // expired and a newer invocation acquired the key, release() is a no-op.
      if (lockLease) {
        try {
          await lockLease.release()
        } catch (unlockErr) {
          logger.warn(`[${jobName}] Failed to release lock:`, unlockErr)
        }
      }
    }
  }
}
