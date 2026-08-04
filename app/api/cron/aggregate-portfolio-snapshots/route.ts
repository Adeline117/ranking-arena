/**
 * GET /api/cron/aggregate-portfolio-snapshots
 *
 * Authenticated compatibility no-op for Arena V1. The legacy credential sync
 * plane is retired, so rolling stale positions into new snapshots would create
 * misleading freshness. Historical rows are preserved for owner audit/removal.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    status: 'retired',
    snapshots: 0,
    reason: 'Legacy portfolio snapshot aggregation is disabled in Arena V1',
  })
}
