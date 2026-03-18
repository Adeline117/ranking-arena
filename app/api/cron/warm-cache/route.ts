/**
 * GET /api/cron/warm-cache
 *
 * Lightweight cron that keeps the Supabase connection pool warm
 * by issuing a single no-op query every 5 minutes.
 * Prevents cold-start latency spikes on the first real request after idle periods.
 *
 * Schedule: every 5 minutes (configured in vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()

  try {
    const supabase = getSupabaseAdmin()

    // Single lightweight query to keep connection pool warm
    const { error } = await supabase
      .from('leaderboard_ranks')
      .select('id')
      .limit(1)

    const duration = Date.now() - start

    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message, duration_ms: duration },
        { status: 500 }
      )
    }

    return NextResponse.json({
      ok: true,
      duration_ms: duration,
      warmed_at: new Date().toISOString(),
    })
  } catch (err) {
    const duration = Date.now() - start
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        duration_ms: duration,
      },
      { status: 500 }
    )
  }
}
