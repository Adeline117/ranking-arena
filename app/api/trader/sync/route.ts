/**
 * POST /api/trader/sync — RETIRED FOR V1
 *
 * A CEX account UID is not a public leaderboard identity. The historical
 * endpoint queued every active credential for public first-party publication,
 * which could attach private account data to an unreviewed Arena trader.
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const RETIRED_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        'Public first-party trader sync is unavailable in Arena V1. Account connections do not prove leaderboard-profile ownership.',
    },
    { status: 410, headers: RETIRED_HEADERS }
  )
}
