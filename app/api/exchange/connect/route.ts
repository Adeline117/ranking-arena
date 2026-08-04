/**
 * POST /api/exchange/connect — RETIRED
 *
 * This endpoint used to write only user_exchange_connections. Keeping it live
 * would let a credential rotation diverge from trader_authorizations and bypass
 * the exchange-authoritative read-only permission proof used by the V1 binder.
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
      error: 'This exchange connection endpoint is retired. Use /api/trader/authorize.',
      successor: '/api/trader/authorize',
    },
    { status: 410, headers: RETIRED_HEADERS }
  )
}
