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

    // MONITORING: Check if any recently-created rows have violations.
    // If violations exist in data < 2 hours old, a connector is ACTIVELY producing bad data.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const { count: freshViolations } = await supabase
      .from('trader_snapshots_v2')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', twoHoursAgo)
      .or('sharpe_ratio.gt.10,sharpe_ratio.lt.-10,roi_pct.gt.10000,roi_pct.lt.-10000,max_drawdown.gt.100,max_drawdown.lt.0,win_rate.gt.100,win_rate.lt.0')

    if (freshViolations && freshViolations > 0) {
      // Connector is producing bad data NOW — alert
      try {
        const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
        await sendRateLimitedAlert({
          title: `数据质量告警: ${freshViolations} 条新违规数据`,
          message: `最近2小时内写入了 ${freshViolations} 条违反校验规则的快照。某个 connector 可能在产出脏数据。\n已自动清理 ${totalFixed} 条历史违规。`,
          level: 'critical',
          details: { freshViolations, historicalFixed: totalFixed },
        }, 'cleanup-violations-fresh', 30 * 60 * 1000) // Rate limit: 1 alert per 30 min
      } catch {
        // Alert delivery is best-effort
      }
    }

    return NextResponse.json({ fixed: totalFixed, freshViolations: freshViolations ?? 0, details: results })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
