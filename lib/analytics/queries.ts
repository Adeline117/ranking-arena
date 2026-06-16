/**
 * ClickHouse analytics query module
 *
 * Each function attempts ClickHouse first, then falls back to Supabase
 * if ClickHouse is unavailable or errors.
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
 * Get time-series history for a trader (ROI, PnL, arena_score, rank).
 * Falls back to Supabase trader_snapshots_v2 if ClickHouse is unavailable.
 */
export async function getTraderHistory(
  platform: string,
  traderKey: string,
  days = 30
): Promise<TraderHistoryPoint[]> {
  // Try ClickHouse first
  if (isClickHouseAvailable()) {
    try {
      const rows = await query<TraderHistoryPoint>(
        `SELECT
           formatDateTime(captured_at, '%Y-%m-%dT%H:%i:%S.000Z') AS captured_at,
           roi_pct,
           pnl_usd,
           arena_score,
           rank
         FROM trader_snapshots_history
         WHERE platform = {platform:String}
           AND trader_key = {traderKey:String}
           AND captured_at >= now() - INTERVAL {days:UInt32} DAY
         ORDER BY captured_at ASC`,
        { platform, traderKey, days }
      )
      if (rows && rows.length > 0) return rows
    } catch (err) {
      chLogger.warn(
        'getTraderHistory ClickHouse fallback:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // Fallback: Supabase. Migrated off retiring trader_snapshots_v2 →
  // trader_daily_snapshots (daily roi/pnl series; arena_score/rank not stored
  // there — left 0, same as the prior v2 fallback which had no rank).
  const supabase = getSupabaseAdmin() as SupabaseClient
  const sinceDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('trader_daily_snapshots')
    .select('date, roi, pnl')
    .eq('platform', platform)
    .eq('trader_key', traderKey)
    .gte('date', sinceDate)
    .order('date', { ascending: true })

  if (error) {
    chLogger.warn('getTraderHistory Supabase error:', error.message)
    return []
  }

  return (data ?? []).map((row) => ({
    captured_at: row.date,
    roi_pct: row.roi ?? 0,
    pnl_usd: row.pnl ?? 0,
    arena_score: 0,
    rank: 0,
  }))
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
 * Get traders with the biggest arena score changes over the given period.
 * Falls back to Supabase with a simpler query.
 */
export async function getTopMovers(
  period: '7D' | '30D' | '90D' = '30D',
  limit = 20
): Promise<TopMover[]> {
  if (isClickHouseAvailable()) {
    try {
      const rows = await query<TopMover>(
        `WITH
           latest AS (
             SELECT platform, trader_key, period, arena_score,
                    ROW_NUMBER() OVER (PARTITION BY platform, trader_key, period ORDER BY captured_at DESC) AS rn
             FROM trader_snapshots_history
             WHERE period = {period:String}
               AND captured_at >= now() - INTERVAL 24 HOUR
           ),
           earliest AS (
             SELECT platform, trader_key, period, arena_score,
                    ROW_NUMBER() OVER (PARTITION BY platform, trader_key, period ORDER BY captured_at ASC) AS rn
             FROM trader_snapshots_history
             WHERE period = {period:String}
               AND captured_at >= now() - INTERVAL 7 DAY
               AND captured_at <= now() - INTERVAL 6 DAY
           )
         SELECT
           l.platform,
           l.trader_key,
           l.period,
           round(l.arena_score - e.arena_score, 2) AS score_change,
           l.arena_score AS latest_score,
           e.arena_score AS earliest_score
         FROM latest l
         JOIN earliest e ON l.platform = e.platform
           AND l.trader_key = e.trader_key
           AND l.period = e.period
         WHERE l.rn = 1 AND e.rn = 1
         ORDER BY abs(l.arena_score - e.arena_score) DESC
         LIMIT {limit:UInt32}`,
        { period, limit }
      )
      if (rows && rows.length > 0) return rows
    } catch (err) {
      chLogger.warn(
        'getTopMovers ClickHouse fallback:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // Fallback: Supabase — current scores only (no historical diff), rough proxy.
  // Migrated off retiring trader_snapshots_v2 → leaderboard_ranks (aliased).
  const supabase = getSupabaseAdmin() as SupabaseClient
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('platform:source, trader_key:source_trader_id, window:season_id, arena_score')
    .eq('season_id', period)
    .not('arena_score', 'is', null)
    .order('arena_score', { ascending: false })
    .limit(limit)

  if (error) {
    chLogger.warn('getTopMovers Supabase error:', error.message)
    return []
  }

  return (data ?? []).map((row) => ({
    platform: row.platform,
    trader_key: row.trader_key,
    period: row.window,
    score_change: 0, // No historical data in Supabase fallback
    latest_score: row.arena_score ?? 0,
    earliest_score: 0,
  }))
}
