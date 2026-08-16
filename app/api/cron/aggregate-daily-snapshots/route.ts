/**
 * Retired unproven daily-snapshot writer.
 *
 * The former job mixed a periodless historical RPC, mutable 90D leaderboard
 * rows, and current ranks backfilled into earlier dates. The destination table
 * has no season, generation, cohort, or publication-proof identity, so those
 * writes cannot support authoritative historical metrics.
 *
 * Existing history remains readable. New writes stay disabled until a
 * provenance-bound producer can finalize a complete daily cohort atomically.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

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
      replacement: 'provenance-bound daily snapshot publisher',
    },
    { status: 410, headers: NO_STORE_HEADERS }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
