/**
 * Quarantined public trader history.
 *
 * Raw legacy rows remain in storage for operator forensics, but they are not
 * exposed as a product time series without publication provenance.
 */

import { NextResponse } from 'next/server'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

const emptyCoverage = (expectedCount: number) => ({
  state: 'unknown',
  reason: 'snapshot_provenance_unverified',
  count: 0,
  expectedCount,
})

export const runtime = 'edge'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export function GET() {
  return NextResponse.json(
    {
      contract: 'arena.trader-history-evidence@2',
      usage: 'forensic_only',
      provenance: 'unverified',
      derivedMetricsAllowed: false,
      available: false,
      code: 'TRADER_HISTORY_NOT_PUBLISHED',
      reason: 'snapshot_provenance_unverified',
      publication: null,
      sourceAsOf: null,
      history: { '7D': [], '30D': [], '90D': [] },
      coverage: {
        '7D': emptyCoverage(7),
        '30D': emptyCoverage(30),
        '90D': emptyCoverage(90),
      },
    },
    { status: 200, headers: NO_STORE_HEADERS }
  )
}
