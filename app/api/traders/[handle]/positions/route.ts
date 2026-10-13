/**
 * Public position transport.
 *
 * Legacy portfolio/live-position rows expose entry price, mark price, margin,
 * liquidation level, and PnL without a public cost-basis or price authority.
 * Keep this endpoint structurally empty rather than forwarding an old cache
 * or substituting zero-valued positions.
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

  const { handle } = await params
  if (!handle || handle.length > 255) {
    return NextResponse.json(
      { error: 'Invalid handle' },
      { status: 400, headers: LEGACY_METRIC_NO_STORE_HEADERS }
    )
  }

  return NextResponse.json(
    {
      positions: [],
      totalPnl: null,
      totalPnlPct: null,
      publication: LEGACY_METRIC_PUBLICATION_UNAVAILABLE,
      cacheState: 'quarantined',
    },
    { headers: LEGACY_METRIC_NO_STORE_HEADERS }
  )
}
