/**
 * Quarantined technical indicators derived from legacy daily rows.
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
      code: 'DAILY_INDICATORS_NOT_PUBLISHED',
      reason: 'snapshot_provenance_unverified',
      publication: null,
      sourceAsOf: null,
      timestamps: [],
      rsi: [],
      macd: { line: [], signal: [], histogram: [] },
      bollingerBands: { upper: [], middle: [], lower: [] },
      sma: { sma7: [], sma14: [], sma30: [] },
      ema: { ema7: [], ema14: [], ema30: [] },
    },
    { status: 200, headers: NO_STORE_HEADERS }
  )
}
