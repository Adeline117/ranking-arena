/**
 * GET /api/cron/cleanup-violations
 *
 * Incremental cleanup of historical data quality violations.
 * Fixes 30 rows per invocation via server-side RPC.
 *
 * MONITORING: After cleanup, checks if any FRESH violations exist (created in last 2 hours).
 * If yes, a connector is actively producing bad data → triggers Telegram alert.
 *
 * Self-disabling: returns { done: true } when no more violations remain.
 *
 * Schedule: Every 5 minutes (Vercel cron)
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
      batch_limit: 30,
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const results = (data || []) as Array<{ issue: string; fixed: number }>
    const totalFixed = results.reduce((s: number, r: { fixed: number }) => s + r.fixed, 0)

    if (totalFixed === 0) {
      return NextResponse.json({ done: true, message: 'No more violations to fix' })
    }

    // MONITORING: Check if cleanup is finding violations in FRESH data.
    // Use pipeline_rejected_writes table instead of scanning trader_snapshots_v2
    // (the v2 table scan is too slow). If validateBeforeWrite rejects fresh rows,
    // it logs them there — so we just check recent rejections.
    let freshViolations = 0
    try {
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString()
      const { count } = await supabase
        .from('pipeline_rejected_writes')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', oneHourAgo)
        .eq('target_table', 'trader_snapshots_v2')

      freshViolations = count ?? 0
      if (freshViolations > 10) {
        const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
        await sendRateLimitedAlert({
          title: `数据质量告警: ${freshViolations} 条被拦截`,
          message: `最近1小时内 validateBeforeWrite 拦截了 ${freshViolations} 条脏快照。某个 connector 可能在产出脏数据。\n已自动清理 ${totalFixed} 条历史违规。`,
          level: 'critical',
          details: { freshViolations, historicalFixed: totalFixed },
        }, 'cleanup-violations-fresh', 30 * 60 * 1000)
      }
    } catch {
      // Monitoring is best-effort — don't block cleanup
    }

    return NextResponse.json({ fixed: totalFixed, freshViolations, details: results })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
