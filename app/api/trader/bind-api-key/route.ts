/**
 * POST /api/trader/bind-api-key — RETIRED
 *
 * /api/trader/authorize is the sole V1 API-key binding endpoint. Keeping this
 * duplicate writer live would create a second public contract around the same
 * credential lifecycle.
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const RETIRED_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Link: '</api/trader/authorize>; rel="successor-version"',
} as const

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'This API key binding endpoint is retired. Use /api/trader/authorize.',
      successor: '/api/trader/authorize',
    },
    { status: 410, headers: RETIRED_HEADERS }
  )
}
