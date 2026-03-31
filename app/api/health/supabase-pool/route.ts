/**
 * GET /api/health/supabase-pool
 *
 * Monitors Supabase (PostgreSQL) connection pool utilization.
 * Returns active connection count, max connections, utilization percentage,
 * and a health status (healthy / warning / critical).
 *
 * Auth: Requires CRON_SECRET bearer token.
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:supabase-pool')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_CONNECTIONS = 100 // Supabase default pool size
const WARNING_THRESHOLD = 0.70 // 70%
const CRITICAL_THRESHOLD = 0.85 // 85%

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // Query active connections via pg_stat_activity
    const { data, error } = await supabase.rpc('get_active_connections')

    let activeConnections: number

    if (error || !data) {
      // Fallback: use a raw count query via PostgREST-compatible approach
      // If the RPC doesn't exist, we estimate from a lightweight query
      const { count, error: countError } = await supabase
        .from('pipeline_logs')
        .select('id', { count: 'exact', head: true })
        .limit(0)

      if (countError) {
        return NextResponse.json(
          {
            error: 'Unable to query connection pool',
            details: error?.message || countError.message,
            hint: 'Create the get_active_connections() RPC function for accurate monitoring',
          },
          { status: 500 }
        )
      }

      // Without the RPC, we can't get real connection count.
      // Return a degraded response indicating the RPC is needed.
      return NextResponse.json({
        active_connections: null,
        max_connections: MAX_CONNECTIONS,
        utilization_pct: null,
        status: 'degraded',
        message: 'RPC get_active_connections() not found. Create it for accurate pool monitoring.',
        migration_sql: `CREATE OR REPLACE FUNCTION get_active_connections() RETURNS INTEGER AS $$ SELECT count(*)::integer FROM pg_stat_activity WHERE datname = current_database(); $$ LANGUAGE sql SECURITY DEFINER;`,
        db_reachable: count !== null,
      })
    }

    activeConnections = typeof data === 'number' ? data : parseInt(String(data), 10)
    const utilizationPct = Math.round((activeConnections / MAX_CONNECTIONS) * 10000) / 100

    let status: 'healthy' | 'warning' | 'critical'
    if (activeConnections / MAX_CONNECTIONS >= CRITICAL_THRESHOLD) {
      status = 'critical'
    } else if (activeConnections / MAX_CONNECTIONS >= WARNING_THRESHOLD) {
      status = 'warning'
    } else {
      status = 'healthy'
    }

    return NextResponse.json({
      active_connections: activeConnections,
      max_connections: MAX_CONNECTIONS,
      utilization_pct: utilizationPct,
      status,
      checked_at: new Date().toISOString(),
    })
  } catch (err) {
    log.error('Error', { error: err instanceof Error ? err.message : String(err) })
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
