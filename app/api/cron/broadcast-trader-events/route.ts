/**
 * Retired followed-trader event broadcaster.
 *
 * V1 does not publish verified automatic trader-event monitoring or delivery.
 * A direct authenticated request must not inspect rank or position data, write
 * notification state, or send a push notification.
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

export function GET(request: Request): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      code: TRADER_NOTIFICATION_NOT_PUBLISHED_CODE,
      replacement: 'none; trader-event publication requires a separately approved release',
      message: TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE,
    },
    { status: 410, headers: TRADER_ALERTS_NO_STORE_HEADERS }
  )
}
