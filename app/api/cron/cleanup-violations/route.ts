/**
 * Retired historical snapshot-violation cleanup.
 *
 * The former RPC could mutate periodless daily/equity history without a
 * publication proof. There is no automatic repair replacement, and the former
 * scanner is also retired while the daily producer is quarantined. Operator
 * review is required.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 10

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

function retiredResponse(request: NextRequest): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS })
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      replacement: 'none; operator review required',
    },
    { status: 410, headers: NO_STORE_HEADERS }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
