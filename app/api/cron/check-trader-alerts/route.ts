/**
 * Retired trader-alert evaluator and delivery cron.
 *
 * V1 has no verified automatic schedule or delivery witness. Do not let a
 * direct authenticated caller evaluate alerts, advance baselines, or send push
 * or email notifications until a separately approved publication plan exists.
 */

import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import {
  TRADER_ALERTS_NOT_PUBLISHED_CODE,
  TRADER_ALERTS_NO_STORE_HEADERS,
  TRADER_ALERTS_UNAVAILABLE_MESSAGE,
} from '@/lib/alerts/trader-alert-publication'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

function retiredResponse(request: Request): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      code: TRADER_ALERTS_NOT_PUBLISHED_CODE,
      replacement: 'none; trader-alert publication requires a separately approved release',
      message: TRADER_ALERTS_UNAVAILABLE_MESSAGE,
    },
    { status: 410, headers: TRADER_ALERTS_NO_STORE_HEADERS }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
