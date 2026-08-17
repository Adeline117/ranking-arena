/**
 * Platform heartbeat history endpoint.
 *
 * V1 keeps the authenticated GET history surface in place. The legacy POST
 * write ingress is authenticated first and unavailable while cron execution
 * remains unpublished.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import {
  v1CronExecutionGate,
  v1CronExecutionUnavailableResponse,
} from '@/lib/cron/v1-execution-publication'

export const dynamic = 'force-dynamic'

async function getDb() {
  // Preserve the legacy history reader without relying on generated table types.
  const { query } = await import('@/lib/db')
  return query
}

/** POST /api/health/heartbeat — V1 legacy heartbeat write hold. */
export function POST(request: NextRequest) {
  return v1CronExecutionGate(request) ?? v1CronExecutionUnavailableResponse()
}

/** GET /api/health/heartbeat — Get latest heartbeat per platform */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dbQuery = await getDb()

  try {
    const result = await dbQuery(
      `SELECT DISTINCT ON (platform)
         platform, source_host, status, trader_count, error_message, created_at,
         ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600, 1) AS hours_since
       FROM platform_heartbeats
       ORDER BY platform, created_at DESC`,
      []
    )

    const platforms = (result.rows || []).map((row: Record<string, unknown>) => ({
      ...row,
      is_stale: Number(row.hours_since) > 6,
      is_critical: Number(row.hours_since) > 24,
    }))

    return NextResponse.json({ ok: true, platforms })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
