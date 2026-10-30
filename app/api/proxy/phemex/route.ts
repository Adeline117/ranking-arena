/**
 * Retired Phemex proxy acquisition route.
 *
 * The prior Edge proxy acquired upstream leaderboard data. V1 verification
 * keeps this source endpoint fail-closed; this source-only hold does not stop
 * an already deployed host or independently running process.
 */

import { NextResponse } from 'next/server'
import { verifyEdgeCronSecret } from '@/lib/auth/edge-cron-auth'

export const runtime = 'edge'
export const preferredRegion = ['iad1']

export const LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED =
  'LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED' as const

export const LEGACY_PROXY_ACQUISITION_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

/**
 * Authenticate before disclosing the V1 publication hold. Do not inspect the
 * request URL or invoke an acquisition implementation from this route.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!(await verifyEdgeCronSecret(request))) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: LEGACY_PROXY_ACQUISITION_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      error: LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED,
      message: 'Legacy proxy acquisition is temporarily unavailable during V1 verification.',
    },
    { status: 410, headers: LEGACY_PROXY_ACQUISITION_NO_STORE_HEADERS }
  )
}
