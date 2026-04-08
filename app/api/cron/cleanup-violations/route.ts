/**
 * GET /api/cron/cleanup-violations
 *
 * Incremental cleanup of historical data quality violations.
 * Fixes 200 rows per invocation to avoid timeout/OOM on the 1.18GB April partition.
 *
 * At 200 rows/call, 1 call/min: cleans ~12k/hour, ~103k violations in ~9 hours.
 * Self-disabling: returns { done: true } when no more violations remain.
 *
 * Schedule: Every 1 minute (Vercel cron)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  try {
    const { data, error } = await supabase.rpc('cleanup_snapshot_violations', {
      batch_limit: 50,
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const results = (data || []) as Array<{ issue: string; fixed: number }>
    const totalFixed = results.reduce((s: number, r: { fixed: number }) => s + r.fixed, 0)

    if (totalFixed === 0) {
      return NextResponse.json({ done: true, message: 'No more violations to fix' })
    }

    return NextResponse.json({ fixed: totalFixed, details: results })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
