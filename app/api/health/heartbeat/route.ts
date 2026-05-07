/**
 * POST /api/health/heartbeat — Platform heartbeat endpoint
 *
 * Called by Mac Mini scrapers, VPS scripts, and Vercel cron jobs to report
 * their health status. Makes all data sources visible in the monitoring dashboard.
 *
 * Body: { platform, source_host, status, trader_count, error_message?, metadata? }
 * Auth: CRON_SECRET (same as cron jobs)
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

async function getDb() {
  // Use raw query to bypass generated types (platform_heartbeats is new, not in types yet)
  const { query } = await import('@/lib/db')
  return query
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body?.platform) {
    return NextResponse.json({ error: 'Missing required field: platform' }, { status: 400 })
  }

  const dbQuery = await getDb()

  try {
    await dbQuery(
      `INSERT INTO platform_heartbeats (platform, source_host, status, trader_count, error_message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform, immutable_date_trunc_hour(created_at)) DO UPDATE
       SET status = EXCLUDED.status,
           trader_count = EXCLUDED.trader_count,
           error_message = EXCLUDED.error_message,
           metadata = EXCLUDED.metadata`,
      [
        body.platform,
        body.source_host || 'unknown',
        body.status || 'ok',
        body.trader_count || 0,
        body.error_message || null,
        JSON.stringify(body.metadata || {}),
      ]
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
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
