/**
 * V1 cron execution publication boundary.
 *
 * Checked-in automation is intentionally fail-closed while V1 evidence and
 * owner GO criteria remain incomplete. This is a source-only guard: it does
 * not cancel a previously deployed schedule or stop an already-running host.
 * Reopening cron execution requires a separately reviewed change; it must not
 * be controlled by an environment variable.
 */

import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const V1_CRON_EXECUTION_PUBLISHED = false as const

export const V1_CRON_EXECUTION_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

export const V1_CRON_EXECUTION_NOT_PUBLISHED_CODE = 'CRON_EXECUTION_NOT_PUBLISHED' as const

export function isV1CronExecutionPublished(): boolean {
  return V1_CRON_EXECUTION_PUBLISHED
}

export function v1CronExecutionUnavailableResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Cron execution is temporarily unavailable during V1 verification.',
      code: V1_CRON_EXECUTION_NOT_PUBLISHED_CODE,
    },
    { status: 410, headers: V1_CRON_EXECUTION_NO_STORE_HEADERS }
  )
}

/**
 * Authenticate first, then keep the V1 execution hold outside every lock,
 * pipeline log, queue, cache, database, and provider call.
 */
export function v1CronExecutionGate(request: Request): NextResponse | null {
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_CRON_EXECUTION_NO_STORE_HEADERS }
    )
  }

  if (!isV1CronExecutionPublished()) return v1CronExecutionUnavailableResponse()

  return null
}
