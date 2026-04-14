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
import { safeParseInt } from '@/lib/utils/safe-parse'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const log = createLogger('api:supabase-pool')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_CONNECTIONS = 100 // Supabase default pool size
const WARNING_THRESHOLD = 0.70 // 70%
const CRITICAL_THRESHOLD = 0.85 // 85%

export async function GET(request: NextRequest) {
  // SECURITY: Reject if CRON_SECRET not configured in production
  if (!env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    log.error('CRON_SECRET not configured')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 503 })
  }

  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()

    // Query active connections via pg_stat_activity
    const { data, error } = await supabase.rpc('get_active_connections')

    if (error || !data) {
      // Fallback: cheapest possible liveness probe — fetch one row and
      // ignore the result. Previously used count: 'exact' which forced
      // a full scan of pipeline_logs just to prove the pool was alive.
      const { data: probe, error: countError } = await supabase
        .from('pipeline_logs')
        .select('id')
        .limit(1)
      const dbReachable = !countError && probe !== null

      if (countError) {
        return NextResponse.json(
          {
            error: 'Unable to query connection pool',
            details: 'Database connection pool error',
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
        db_reachable: dbReachable,
      })
    }

    const activeConnections = typeof data === 'number' ? data : safeParseInt(String(data), 0)
    const utilizationPct = Math.round((activeConnections / MAX_CONNECTIONS) * 10000) / 100

    let status: 'healthy' | 'warning' | 'critical'
    if (activeConnections / MAX_CONNECTIONS >= CRITICAL_THRESHOLD) {
      status = 'critical'
    } else if (activeConnections / MAX_CONNECTIONS >= WARNING_THRESHOLD) {
      status = 'warning'
    } else {
      status = 'healthy'
    }

    // Fetch detailed connection breakdown for diagnostics
    let connectionStats: Array<{ state: string; count: number; oldest_query_seconds: number }> | null = null
    if (status !== 'healthy') {
      // Only fetch details when pool is under pressure (saves a query in normal case)
      try {
        const { data: statsData } = await supabase.rpc('get_connection_stats')
        if (statsData) connectionStats = statsData as typeof connectionStats
      } catch {
        // Non-critical — main count is enough
      }
    }

    return NextResponse.json({
      active_connections: activeConnections,
      max_connections: MAX_CONNECTIONS,
      utilization_pct: utilizationPct,
      status,
      checked_at: new Date().toISOString(),
      ...(connectionStats ? { connection_breakdown: connectionStats } : {}),
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
