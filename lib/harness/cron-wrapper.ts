/**
 * Cron Harness Wrapper — unified PipelineLogger + auth for all cron routes.
 *
 * Usage:
 *   import { withCronHarness } from '@/lib/harness/cron-wrapper'
 *   export const GET = withCronHarness('my-job-name', async (request, { plog }) => {
 *     const count = await doWork()
 *     return { count }
 *   })
 *
 * Provides:
 * - CRON_SECRET auth check
 * - PipelineLogger start/success/error lifecycle
 * - Structured JSON response
 * - Error handling with proper status codes
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'

export interface CronContext {
  plog: Awaited<ReturnType<typeof PipelineLogger.start>>
  startTime: number
}

type CronHandler = (
  request: NextRequest,
  ctx: CronContext
) => Promise<Record<string, unknown> | void>

/**
 * Wrap a cron route handler with auth + PipelineLogger lifecycle.
 * Returns a Next.js GET handler.
 */
export function withCronHarness(jobName: string, handler: CronHandler) {
  return async function GET(request: NextRequest) {
    // Auth check
    const authHeader = request.headers.get('authorization')
    if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const startTime = Date.now()
    const plog = await PipelineLogger.start(jobName)

    try {
      const result = await handler(request, { plog, startTime })
      const duration = Date.now() - startTime

      // If handler didn't call plog.success, do it now
      await plog.success(
        typeof result === 'object' && result !== null && 'count' in result
          ? (result.count as number)
          : 0,
        result ?? undefined
      )

      return NextResponse.json({
        success: true,
        job: jobName,
        duration: `${duration}ms`,
        ...result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await plog.error(error instanceof Error ? error : new Error(message))

      return NextResponse.json(
        { success: false, job: jobName, error: message, duration: `${Date.now() - startTime}ms` },
        { status: 500 }
      )
    }
  }
}

/**
 * Same as withCronHarness but for POST handlers.
 */
export function withCronHarnessPost(jobName: string, handler: CronHandler) {
  return async function POST(request: NextRequest) {
    const authHeader = request.headers.get('authorization')
    if (env.CRON_SECRET && authHeader !== `Bearer ${env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const startTime = Date.now()
    const plog = await PipelineLogger.start(jobName)

    try {
      const result = await handler(request, { plog, startTime })
      const duration = Date.now() - startTime

      await plog.success(
        typeof result === 'object' && result !== null && 'count' in result
          ? (result.count as number)
          : 0,
        result ?? undefined
      )

      return NextResponse.json({
        success: true,
        job: jobName,
        duration: `${duration}ms`,
        ...result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await plog.error(error instanceof Error ? error : new Error(message))

      return NextResponse.json(
        { success: false, job: jobName, error: message, duration: `${Date.now() - startTime}ms` },
        { status: 500 }
      )
    }
  }
}
