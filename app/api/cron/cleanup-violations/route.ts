/**
 * GET /api/cron/cleanup-violations
 *
 * Incremental cleanup of historical data quality violations.
 * Uses server-side RPC with small batch to fit within Supabase 10s timeout.
 *
 * Schedule: Every 5 minutes (Vercel cron)
 *
 * Observability: migrated to withCron (2026-04-16) — previously this was the
 * one cron route skipping pipeline_logs entirely, so timeouts/errors never
 * showed up in OpenClaw's monitoring or /api/health/pipeline. withCron also
 * adds the distributed Redis lock (prevents concurrent execution) and the
 * safety timeout with a `timeout` pipeline_logs entry.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron('cleanup-violations', async (_request: NextRequest, { supabase }) => {
  // Run multiple small batches within one cron invocation
  let totalFixed = 0
  const maxBatches = 10
  let rpcError: string | null = null

  for (let i = 0; i < maxBatches; i++) {
    // Clean all 3 tables: snapshots_v2, daily_snapshots, equity_curve
    const { data, error } = await supabase.rpc('cleanup_all_data_violations', {
      batch_limit: 5,
    })

    if (error) {
      // Fallback to old function if new one doesn't exist yet
      const { data: fallback, error: fbErr } = await supabase.rpc('cleanup_snapshot_violations', {
        batch_limit: 5,
      })
      if (fbErr) {
        // First iteration RPC failure → surface as a real cron error so
        // PipelineLogger records status='error' and alerts fire.
        if (i === 0) throw new Error(`cleanup RPC failed: ${fbErr.message}`)
        rpcError = fbErr.message
        break
      }
      const fbResults = (fallback || []) as Array<{ issue: string; fixed: number }>
      totalFixed += fbResults.reduce((s: number, r: { fixed: number }) => s + r.fixed, 0)
      if (totalFixed === 0) break
      continue
    }

    const results = (data || []) as Array<{ issue: string; fixed: number; target_table?: string }>
    const batchFixed = results.reduce((s: number, r: { fixed: number }) => s + r.fixed, 0)
    totalFixed += batchFixed

    if (batchFixed === 0) break // No more violations in any table
  }

  // Monitoring: check pipeline_rejected_writes for fresh connector issues
  // Estimated count — this is a threshold check (>10 triggers alert).
  // pipeline_rejected_writes rotates at 7d (~126k rows typical) and the
  // 1h window is a tiny subset; planner estimate via EXPLAIN is fine.
  let freshViolations = 0
  try {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString()
    const { count } = await supabase
      .from('pipeline_rejected_writes')
      .select('id', { count: 'estimated', head: true })
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
  } catch (monitorErr) {
    // Don't fail the cron job on a monitoring glitch, but surface the
    // failure in Sentry so silent regressions in the count-query or
    // alert pipeline are caught.
    logger.error('[cleanup-violations] Fresh-violation monitoring failed', {
      error: monitorErr instanceof Error ? monitorErr.message : String(monitorErr),
      totalFixed,
    })
  }

  // `count` is picked up by PipelineLogger.success as records_processed.
  // Returning additional fields lets operators see the full picture in
  // pipeline_logs.metadata and /api/health/pipeline.
  return {
    count: totalFixed,
    fixed: totalFixed,
    freshViolations,
    done: totalFixed === 0,
    ...(rpcError ? { rpcErrorAfterFirstBatch: rpcError } : {}),
    ...(totalFixed === 0
      ? { message: 'All violations cleaned. Trigger enforces quality. Run VALIDATE CONSTRAINT via psql for query planner optimization.' }
      : {}),
  }
})
