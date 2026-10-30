/**
 * ClickHouse analytics query module
 *
 * Operational aggregates may fall back from ClickHouse to Supabase. Product
 * history/mover exports are quarantined until a versioned publication source
 * exists; they never synthesize a fallback series.
 */

import { logger } from '@/lib/logger'
import { isClickHouseAvailable, query } from './clickhouse'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

const chLogger = logger.child('ClickHouse:Queries')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraderHistoryPoint {
  captured_at: string
  roi_pct: number
  pnl_usd: number
  arena_score: number
  rank: number
}

export interface PipelineStat {
  job_name: string
  total_runs: number
  success_count: number
  error_count: number
  success_rate: number
  avg_duration_ms: number
}

export interface TopMover {
  platform: string
  trader_key: string
  period: string
  score_change: number
  latest_score: number
  earliest_score: number
}

// ---------------------------------------------------------------------------
// getTraderHistory
// ---------------------------------------------------------------------------

/**
 * Historical analytics are quarantined until their source is bound to a
 * sealed publication. Keep the export for callers, but never synthesize a
 * product series from legacy stores.
 */
export async function getTraderHistory(
  platform: string,
  traderKey: string,
  days = 30
): Promise<TraderHistoryPoint[]> {
  void platform
  void traderKey
  void days
  return []
}

// ---------------------------------------------------------------------------
// getPipelineStats
// ---------------------------------------------------------------------------

/**
 * Get pipeline success rates and avg duration per job.
 * Falls back to Supabase pipeline_job_stats view.
 */
export async function getPipelineStats(days = 7): Promise<PipelineStat[]> {
  if (isClickHouseAvailable()) {
    try {
      const rows = await query<PipelineStat>(
        `SELECT
           job_name,
           count() AS total_runs,
           countIf(status = 'success') AS success_count,
           countIf(status = 'error') AS error_count,
           round(countIf(status = 'success') / count() * 100, 1) AS success_rate,
           round(avg(duration_ms)) AS avg_duration_ms
         FROM pipeline_logs
         WHERE started_at >= now() - INTERVAL {days:UInt32} DAY
           AND status != 'running'
         GROUP BY job_name
         ORDER BY total_runs DESC`,
        { days }
      )
      if (rows && rows.length > 0) return rows
    } catch (err) {
      chLogger.warn(
        'getPipelineStats ClickHouse fallback:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // Fallback: Supabase view
  const supabase = getSupabaseAdmin() as SupabaseClient
  const { data, error } = await supabase
    .from('pipeline_job_stats')
    .select('job_name, total_runs, success_count, error_count, success_rate, avg_duration_ms')

  if (error) {
    chLogger.warn('getPipelineStats Supabase error:', error.message)
    return []
  }

  return (data ?? []).map((row) => ({
    job_name: row.job_name,
    total_runs: row.total_runs ?? 0,
    success_count: row.success_count ?? 0,
    error_count: row.error_count ?? 0,
    success_rate: row.success_rate ?? 0,
    avg_duration_ms: row.avg_duration_ms ?? 0,
  }))
}

// ---------------------------------------------------------------------------
// getTopMovers
// ---------------------------------------------------------------------------

/**
 * Movers require two sealed, comparable publication generations. Neither the
 * legacy ClickHouse history nor a current-score-only fallback proves that
 * contract, so this compatibility export stays empty with the public route.
 */
export async function getTopMovers(
  period: '7D' | '30D' | '90D' = '30D',
  limit = 20
): Promise<TopMover[]> {
  void period
  void limit
  return []
}
