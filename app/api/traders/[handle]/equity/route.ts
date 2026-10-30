/**
 * Quarantined trader equity/PnL/drawdown series.
 *
 * Legacy daily rows do not carry season, generation, cohort, or publication
 * proof. Derived charts stay empty until an atomic authoritative publisher is
 * available.
 */

import { NextResponse } from 'next/server'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export function GET() {
  return NextResponse.json(
    {
      contract: 'arena.daily-history-publication@1',
      available: false,
      code: 'DAILY_SERIES_NOT_PUBLISHED',
      reason: 'snapshot_provenance_unverified',
      publication: null,
      sourceAsOf: null,
      equity: [],
      pnl: [],
      drawdown: [],
    },
    { status: 200, headers: NO_STORE_HEADERS }
  )
}
