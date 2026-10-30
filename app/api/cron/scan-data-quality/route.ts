/**
 * Retired unversioned data-quality scanner.
 *
 * The former admin RPC has no function body in repository migration history,
 * so its read/write behavior and payload cannot be reproduced or reviewed.
 * Keep it disabled until an exact versioned definition and bounded behavior
 * tests exist. There is no automatic replacement.
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
      replacement: 'none; exact versioned scanner required',
    },
    { status: 410, headers: NO_STORE_HEADERS }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
