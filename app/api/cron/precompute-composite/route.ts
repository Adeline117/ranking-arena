/**
 * Retired composite-ranking cache writer.
 *
 * The former job read leaderboard rows without a publication cohort fence and
 * wrote an unsealed Redis payload. Nothing in the serving application reads
 * that cache; composite requests are owned by the public rankings route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

function retiredResponse(request: NextRequest): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      replacement: '/api/rankings?window=composite',
    },
    { status: 410 }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
