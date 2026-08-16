/**
 * Quarantined Top Movers API.
 *
 * The former implementation compared mutable current 90D ranks with
 * periodless historical rows that have no generation/cohort publication
 * proof. Once their producer is retired, those rows also become stale and
 * must not be presented as daily movement.
 *
 * Keep the response shape stable and fail closed until an atomically finalized,
 * provenance-bound daily publisher is available.
 */

import { NextResponse } from 'next/server'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

export function GET() {
  return NextResponse.json(
    {
      risers: [],
      fallers: [],
      period: '90D',
      available: false,
      code: 'MOVERS_NOT_PUBLISHED',
      reason: 'snapshot_provenance_unverified',
      snapshotDate: null,
      compareDate: null,
    },
    {
      status: 200,
      headers: NO_STORE_HEADERS,
    }
  )
}
