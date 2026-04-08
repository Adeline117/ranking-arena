/**
 * GET /api/cron/cleanup-violations
 *
 * Incremental cleanup of historical data quality violations.
 * Uses server-side RPC with small batch to fit within Supabase 10s timeout.
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
    // Run multiple small batches within one cron invocation
    let totalFixed = 0
    const maxBatches = 10

    for (let i = 0; i < maxBatches; i++) {
      const { data, error } = await supabase.rpc('cleanup_snapshot_violations', {
        batch_limit: 5,
      })

      if (error) {
        // If first batch errors, return error; otherwise return partial results
        if (i === 0) return NextResponse.json({ error: error.message }, { status: 500 })
        break
      }

      const results = (data || []) as Array<{ issue: string; fixed: number }>
      const batchFixed = results.reduce((s: number, r: { fixed: number }) => s + r.fixed, 0)
      totalFixed += batchFixed

      if (batchFixed === 0) break // No more violations
    }

    if (totalFixed === 0) {
      // All violations cleaned! The DB trigger (trg_sanitize_snapshot) now enforces
      // data quality on ALL future writes. The NOT VALID constraints can be promoted
      // to VALID via psql: ALTER TABLE trader_snapshots_v2 VALIDATE CONSTRAINT chk_v2_*
      return NextResponse.json({
        done: true,
        message: 'All violations cleaned. Trigger enforces quality. Run VALIDATE CONSTRAINT via psql for query planner optimization.',
      })
    }

    // Monitoring: check pipeline_rejected_writes for fresh connector issues
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
          message: `最近1小时内 validateBeforeWrite 拦截了 ${freshViolations} 条脏快照。\n已自动清理 ${totalFixed} 条历史违规。`,
          level: 'critical',
          details: { freshViolations, historicalFixed: totalFixed },
        }, 'cleanup-violations-fresh', 30 * 60 * 1000)
      }
    } catch {
      // Monitoring is best-effort
    }

    return NextResponse.json({ fixed: totalFixed, freshViolations })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
