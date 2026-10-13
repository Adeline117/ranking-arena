/**
 * Retired ranking-change notification trigger.
 *
 * V1 has no approved, verified publication or delivery path for personalized
 * ranking-change notifications. Direct service-authenticated calls therefore
 * fail closed without reading rankings or writing notification rows.
 */

import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import {
  TRADER_ALERTS_NO_STORE_HEADERS,
  TRADER_NOTIFICATION_NOT_PUBLISHED_CODE,
  TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE,
} from '@/lib/alerts/trader-alert-publication'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 10

export function POST(request: Request): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      error: 'Retired notification trigger',
      code: TRADER_NOTIFICATION_NOT_PUBLISHED_CODE,
      replacement:
        'none; ranking-change notification publication requires a separately approved release',
      message: TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE,
    },
    { status: 410, headers: TRADER_ALERTS_NO_STORE_HEADERS }
  )
}
