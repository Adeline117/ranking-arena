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
import { PipelineLogger, type PipelineLogHandle } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

interface CronContext {
  plog: PipelineLogHandle
  supabase: ReturnType<typeof getSupabaseAdmin>
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
export function withCron(
  jobName: string,
  handler: CronHandler,
  options: CronOptions = {}
) {
  const { safetyTimeoutMs = 580_000 } = options

  return async (request: NextRequest) => {
    // 1. Auth verification
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    // 2. Extract metadata from search params
    const searchParams = Object.fromEntries(request.nextUrl.searchParams.entries())
    const metadata = { ...options.metadata, ...searchParams }

    // 3. Start pipeline logger
    const plog = await PipelineLogger.start(jobName, metadata)
    const supabase = getSupabaseAdmin()

    // 4. Safety timeout
    let safetyFired = false
    const safetyTimer = setTimeout(async () => {
      safetyFired = true
      try {
        await plog.timeout({ reason: 'safety_timeout', safetyTimeoutMs })
        logger.error(`[${jobName}] Safety timeout fired at ${safetyTimeoutMs}ms`)
      } catch (err) { /* best effort - Telegram/Sentry alert */ }
    }, safetyTimeoutMs)

    // 5. Execute handler
    const startTime = Date.now()
    try {
      const result = await handler(request, { plog, supabase })
      clearTimeout(safetyTimer)

      if (safetyFired) {
        // Safety already logged timeout — don't overwrite
        return NextResponse.json({ ok: false, error: 'safety_timeout', partial: result })
      }

      const elapsed = Date.now() - startTime
      await plog.success(result.count ?? 0, { ...result, elapsed_ms: elapsed })

      return NextResponse.json({ ok: true, elapsed_ms: elapsed, ...result })
    } catch (err: unknown) {
      clearTimeout(safetyTimer)
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.error(`[${jobName}] Cron error:`, err)

      if (!safetyFired) {
        await plog.error(err instanceof Error ? err : new Error(errorMessage), {
          elapsed_ms: Date.now() - startTime,
        })
      }

      return NextResponse.json(
        { ok: false, error: errorMessage, elapsed_ms: Date.now() - startTime },
        { status: 500 }
      )
    }
  }
}
