/**
 * Retired Vercel partition cron (2026-11 audit P2-5).
 *
 * It called `ensure_future_partitions()`, whose only target is
 * `trader_snapshots_v2_partitioned` (20260331c) — a table dropped in June
 * 2026; migration 20261013094743 already retired the matching pg_cron job as
 * "can only fail". The live partition pre-creation for the arena.* tables is
 * the ingest worker's `maint:housekeeping` step (`ensurePartitions()` in
 * lib/ingest/serving/series.ts), registered on the local node with an SG
 * standby. Keeping a second, wrong implementation here only produced either
 * failures or a false "partitions ensured" success.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

function retiredResponse(request: NextRequest): NextResponse {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json(
    {
      error: 'Retired cron route',
      reason: 'ensure_future_partitions targets the dropped trader_snapshots_v2 table',
      replacement: 'ingest worker maint:housekeeping → ensurePartitions() (arena.* tables)',
    },
    { status: 410 }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
