/**
 * V1 heartbeat-history publication boundary.
 *
 * The historical platform-heartbeat table is no longer a published read
 * surface in this source revision. This checked-in hold deliberately has no
 * environment override: reopening it requires a separately reviewed source
 * change with an authoritative history dependency.
 */

import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const V1_HEARTBEAT_HISTORY_PUBLISHED = false as const

export const V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE = 'HEARTBEAT_HISTORY_NOT_PUBLISHED' as const

export const V1_HEARTBEAT_HISTORY_UNAVAILABLE_BODY = {
  error: 'Heartbeat history is temporarily unavailable during V1 verification.',
  code: V1_HEARTBEAT_HISTORY_NOT_PUBLISHED_CODE,
} as const

export const V1_HEARTBEAT_HISTORY_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/** Deliberately has no environment override. */
export function isV1HeartbeatHistoryPublished(): boolean {
  return V1_HEARTBEAT_HISTORY_PUBLISHED
}

export function v1HeartbeatHistoryUnavailableResponse(): NextResponse {
  return NextResponse.json(V1_HEARTBEAT_HISTORY_UNAVAILABLE_BODY, {
    status: 410,
    headers: V1_HEARTBEAT_HISTORY_NO_STORE_HEADERS,
  })
}

/**
 * Keep route-owned Cron Token authentication ahead of the fixed V1 read hold.
 * No history dependency is opened for either response.
 */
export function v1HeartbeatHistoryGate(request: Request): NextResponse | null {
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: V1_HEARTBEAT_HISTORY_NO_STORE_HEADERS }
    )
  }

  if (!isV1HeartbeatHistoryPublished()) return v1HeartbeatHistoryUnavailableResponse()

  return null
}
