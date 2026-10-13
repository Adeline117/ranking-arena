/**
 * Retired customer weekly digest cron.
 *
 * V1 has no approved, verified delivery witness for personalized followed-
 * trader activity or ranking summaries. A direct authenticated request must
 * not read subscriber data or send email.
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
      replacement: 'none; personalized digest publication requires a separately approved release',
      message: TRADER_NOTIFICATION_UNAVAILABLE_MESSAGE,
    },
    { status: 410, headers: TRADER_ALERTS_NO_STORE_HEADERS }
  )
}
