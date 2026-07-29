/**
 * Retired legacy derived-metrics writer.
 *
 * The former job called `bulk_update_snapshot_metrics`, whose only target was
 * `trader_snapshots_v2`. That table was physically removed in June 2026, so
 * the route could only swallow an RPC error and report a false success.
 *
 * Derived metrics now belong to the atomic leaderboard build:
 * `compute-leaderboard/enrich-daily-snapshots.ts` computes them before the
 * immutable ranking generation is published. Mutating a published generation
 * afterward would invalidate its cohort authority.
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
      replacement: 'compute-leaderboard atomic generation',
    },
    { status: 410 }
  )
}

export const GET = retiredResponse
export const POST = retiredResponse
