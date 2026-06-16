/**
 * POST /api/pipeline/ingest — RETIRED (2026-06-15)
 *
 * The legacy VPS scraper ingest is decommissioned. The Mac Mini arena worker is
 * the canonical pipeline (writes arena.*), and trader_snapshots_v2 — the table
 * this endpoint wrote — has been retired. Always returns 410 Gone.
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST() {
  return NextResponse.json(
    { ok: false, disabled: true, reason: 'legacy VPS ingest retired; arena pipeline is canonical' },
    { status: 410 }
  )
}
