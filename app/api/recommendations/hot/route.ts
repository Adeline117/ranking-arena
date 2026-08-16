/**
 * Quarantined hot-trader recommendations.
 *
 * The former momentum inputs came from unproven legacy daily rows. Keep the
 * public response empty until equivalent sealed cohorts exist.
 */

import { NextResponse } from 'next/server'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const revalidate = 0

export function GET() {
  return NextResponse.json(
    {
      success: true,
      contract: 'arena.daily-history-publication@1',
      available: false,
      code: 'HOT_TRADERS_NOT_PUBLISHED',
      reason: 'snapshot_provenance_unverified',
      publication: null,
      data: [],
      meta: { count: 0, cached: false },
    },
    { status: 200, headers: NO_STORE_HEADERS }
  )
}
