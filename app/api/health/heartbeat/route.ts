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
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body?.platform) {
    return NextResponse.json({ error: 'Missing required field: platform' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  const { error } = await supabase.from('platform_heartbeats').upsert(
    {
      platform: body.platform,
      source_host: body.source_host || 'unknown',
      status: body.status || 'ok',
      trader_count: body.trader_count || 0,
      error_message: body.error_message || null,
      metadata: body.metadata || {},
      created_at: new Date().toISOString(),
    },
    { onConflict: "platform,date_trunc('hour',created_at)" }
  )

  if (error) {
    // Fallback: insert without upsert (unique constraint may not match exact syntax)
    const { error: insertErr } = await supabase.from('platform_heartbeats').insert({
      platform: body.platform,
      source_host: body.source_host || 'unknown',
      status: body.status || 'ok',
      trader_count: body.trader_count || 0,
      error_message: body.error_message || null,
      metadata: body.metadata || {},
    })
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true })
}

/** GET /api/health/heartbeat — Get latest heartbeat per platform */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('v_platform_health')
    .select('*')
    .order('hours_since_heartbeat', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flag stale platforms (no heartbeat in >6h)
  const platforms = (data || []).map((p: Record<string, unknown>) => ({
    ...p,
    is_stale: Number(p.hours_since_heartbeat) > 6,
    is_critical: Number(p.hours_since_heartbeat) > 24,
  }))

  return NextResponse.json({ ok: true, platforms })
}
