/**
 * Legacy equity-series endpoint.
 *
 * `trader_daily_snapshots` is retained for internal aggregation only. Its
 * ROI/PnL rows cannot establish trusted prices or cost basis for public chart
 * values, so this transport stays structurally empty until a publication
 * authority replaces it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import {
  LEGACY_METRIC_NO_STORE_HEADERS,
  LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
} from '@/lib/data/trader/history-quarantine'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) {
    for (const [name, value] of Object.entries(LEGACY_METRIC_NO_STORE_HEADERS)) {
      rateLimitResponse.headers.set(name, value)
    }
    return rateLimitResponse
  }

  // Keep the handle syntax contract, but do not resolve it: an identity lookup
  // followed by an empty result must not imply that legacy raw metrics exist.
  const { handle } = await params
  if (!handle || handle.length > 255) {
    return NextResponse.json(
      { error: 'Invalid handle' },
      { status: 400, headers: LEGACY_METRIC_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      equity: [],
      pnl: [],
      drawdown: [],
      publication: LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
      cacheState: 'quarantined',
    },
    { headers: LEGACY_METRIC_NO_STORE_HEADERS }
  )
}
