/**
 * Pipeline execution logger
 * Records cron job runs to pipeline_logs table for monitoring
 *
 * Usage:
 *   const log = await PipelineLogger.start('batch-fetch-traders-a')
 *   try {
 *     const count = await doWork()
 *     await log.success(count)
 *   } catch (error) {
 *     await log.error(error)
 *   }
 */

import { logger, fireAndForget } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendAlert, sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { syncPipelineLog } from '@/lib/analytics/dual-write'
import { pingHealthcheck } from '@/lib/utils/healthcheck'

/** Wrap a DB write with a 15s timeout to prevent plog from hanging forever.
 *  Root cause: Supabase connection pool exhaustion causes await to hang indefinitely,
 *  leaving pipeline_logs entries as 'running' for 30+ minutes until cleanup-stuck-logs
 *  marks them as timeout. This affected compute-leaderboard, enrich-*, batch-enrich, etc. */
/** Wrap a DB write (or any thenable) with a 15s timeout to prevent plog from hanging forever.
 *  Accepts Supabase query builders (PromiseLike) as well as native Promises. */
async function withDbTimeout<T>(thenable: PromiseLike<T>, label: string): Promise<T | null> {
  try {
    return await Promise.race([
      Promise.resolve(thenable),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`plog DB write timed out after 15s (${label})`)), 15_000)),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(`[PipelineLogger] ${label}: ${msg}`)
    // Fallback: send alert on DB write timeout so we don't lose visibility
    fireAndForget(
      sendRateLimitedAlert(
        { title: `PipelineLogger DB timeout: ${label}`, message: `DB write timed out after 15s. Error: ${msg}`, level: 'warning' },
        'plog-db-timeout',
        5 * 60 * 1000,
      ),
      'plog-timeout-alert',
    )
    return null
  }
}

function getClient() {
  return getSupabaseAdmin() as SupabaseClient
}

export interface PipelineLogHandle {
  id: number
  success(recordsProcessed?: number, metadata?: Record<string, unknown>): Promise<void>
  error(err: unknown, metadata?: Record<string, unknown>): Promise<void>
  partialSuccess(recordsProcessed: number, failedItems: string[], metadata?: Record<string, unknown>): Promise<void>
  timeout(metadata?: Record<string, unknown>): Promise<void>
}

export class PipelineLogger {
  /**
   * All cron job base names that should be monitored via healthchecks.io dead man's switch.
   * Each entry is the base slug — jobs with group/period suffixes (e.g. batch-fetch-traders-a,
   * batch-enrich-90D) are matched via prefix and roll up to the base slug.
   */
  private static readonly MONITORED_JOBS = new Set([
    // Core data pipeline
    'batch-fetch-traders',
    'batch-enrich',
    'compute-leaderboard',
    'aggregate-daily-snapshots',
    'check-data-freshness',
    'pipeline-fetch',
    'fetch-details',
    'precompute-composite',
    'compute-derived-metrics',
    'calculate-advanced-metrics',
    'backfill-data',

    // Discovery & enrichment
    'batch-discover',
    'enrich-gmx',
    'generate-profiles',
    'backfill-avatars',
    'link-entities',
    'batch-5min',

    // Market data
    'fetch-market-data',
    'fetch-funding-rates',
    'fetch-open-interest',
    'flash-news-fetch',

    // Monitoring & health
    'verify-fetchers',
    'check-data-gaps',
    'check-trader-alerts',
    'cleanup-stuck-logs',
    'cleanup-data',
    'cleanup-deleted-accounts',
    'meta-monitor',

    // Snapshots & ranks
    'snapshot-positions',
    'snapshot-ranks',

    // Search & cache
    'sync-meilisearch',

    // Social & notifications
    'auto-post-market-summary',
    'auto-post-insights',
    'auto-post-twitter',
    'daily-digest',

    // Subscriptions
    'subscription-expiry',
  ])

  /** Derive healthcheck slug from job name (strip group suffixes like -a, -90D) */
  private static getHealthcheckSlug(jobName: string): string | null {
    // Exact match first
    if (this.MONITORED_JOBS.has(jobName)) {
      return jobName
    }
    // Prefix match: batch-fetch-traders-a -> batch-fetch-traders
    for (const monitored of this.MONITORED_JOBS) {
      if (jobName.startsWith(`${monitored}-`)) {
        return monitored
      }
    }
    return null
  }

  static async start(jobName: string, metadata?: Record<string, unknown>): Promise<PipelineLogHandle> {
    const client = getClient()

    // Ping healthchecks.io start signal for critical jobs
    const hcSlug = this.getHealthcheckSlug(jobName)
    if (hcSlug) {
      pingHealthcheck(hcSlug, 'start').catch((err) => {
        logger.warn(`[PipelineLogger] Healthcheck start ping failed for ${hcSlug}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }

    const { data, error } = await client
      .from('pipeline_logs')
      .insert({
        job_name: jobName,
        status: 'running',
        metadata: metadata || {},
      })
      .select('id')
      .single()

    if (error || !data) {
      // If logging fails, return a no-op handle so jobs still run
      logger.warn(`[PipelineLogger] Failed to start log for ${jobName}: ${error?.message}`)
      // Alert so we know pipeline logging is broken (fire-and-forget)
      fireAndForget(sendAlert({
        title: `PipelineLogger 启动失败: ${jobName}`,
        message: `无法插入 pipeline_logs: ${error?.message || 'unknown error'}\n任务仍会运行，但不会被记录。`,
        level: 'warning',
        details: { jobName, error: error?.message || 'no data returned' },
      }), 'pipeline-logger:start-alert')
      return createNoOpHandle()
    }

    const logId = data.id
    const startedAt = Date.now()

    return {
      id: logId,
      async success(recordsProcessed = 0, meta) {
        const durationMs = Date.now() - startedAt
        const endedAt = new Date().toISOString()
        await withDbTimeout(
          client
            .from('pipeline_logs')
            .update({
              status: 'success',
              ended_at: endedAt,
              records_processed: recordsProcessed,
              ...(meta ? { metadata: { ...metadata, ...meta, duration_ms: durationMs } } : { metadata: { ...metadata, duration_ms: durationMs } }),
            })
            .eq('id', logId)
            .then(r => r),
          `${jobName}:success`
        )
        // Ping healthchecks.io success (fire-and-forget)
        if (hcSlug) pingHealthcheck(hcSlug, 'success').catch((err) => {
          logger.warn(`[PipelineLogger] Healthcheck success ping failed for ${hcSlug}: ${err instanceof Error ? err.message : String(err)}`)
        })
        // Dual-write to ClickHouse (fire-and-forget)
        fireAndForget(
          syncPipelineLog({
            id: logId, job_name: jobName, status: 'success',
            started_at: new Date(startedAt).toISOString(), ended_at: endedAt,
            duration_ms: durationMs, records_processed: recordsProcessed,
            metadata: { ...metadata, ...meta, duration_ms: durationMs },
          }),
          'clickhouse-pipeline-log-success'
        )
      },
      async partialSuccess(recordsProcessed = 0, failedItems: string[] = [], meta?: Record<string, unknown>) {
        const durationMs = Date.now() - startedAt
        const endedAt = new Date().toISOString()
        await withDbTimeout(
          client
            .from('pipeline_logs')
            .update({
              status: 'partial_success',
              ended_at: endedAt,
              records_processed: recordsProcessed,
              error_message: failedItems.length > 0 ? `${failedItems.length} items failed: ${failedItems.slice(0, 20).join(', ')}` : null,
              metadata: { ...metadata, ...meta, duration_ms: durationMs, failed_items: failedItems.slice(0, 50) },
            })
            .eq('id', logId)
            .then(r => r),
          `${jobName}:partial`
        )
        // Ping healthchecks.io success (partial is still considered alive)
        if (hcSlug) pingHealthcheck(hcSlug, 'success').catch((err) => {
          logger.warn(`[PipelineLogger] Healthcheck success ping failed for ${hcSlug}: ${err instanceof Error ? err.message : String(err)}`)
        })
        // Dual-write to ClickHouse (fire-and-forget)
        fireAndForget(
          syncPipelineLog({
            id: logId, job_name: jobName, status: 'partial_success',
            started_at: new Date(startedAt).toISOString(), ended_at: endedAt,
            duration_ms: durationMs, records_processed: recordsProcessed,
            error_message: failedItems.length > 0 ? `${failedItems.length} items failed` : null,
            metadata: { ...metadata, ...meta, duration_ms: durationMs, failed_items: failedItems.slice(0, 50) },
          }),
          'clickhouse-pipeline-log-partial-success'
        )
        // Auto-alert on partial failure if there are failed items
        if (failedItems.length > 0) {
          fireAndForget(sendRateLimitedAlert({
            title: `Cron 部分失败: ${jobName}`,
            message: `${failedItems.length} items failed: ${failedItems.slice(0, 5).join(', ')}`,
            level: 'warning',
            details: { job: jobName, failed_count: failedItems.length, duration_ms: durationMs },
          }, `plog:partial:${jobName}`, 600_000), 'pipeline-logger:partial-alert')
        }
      },
      async error(err, meta) {
        const durationMs = Date.now() - startedAt
        const errorMessage = err instanceof Error ? err.message : String(err)
        const endedAt = new Date().toISOString()
        await withDbTimeout(
          client
            .from('pipeline_logs')
            .update({
              status: 'error',
              ended_at: endedAt,
              error_message: errorMessage.slice(0, 2000),
              ...(meta ? { metadata: { ...metadata, ...meta, duration_ms: durationMs } } : { metadata: { ...metadata, duration_ms: durationMs } }),
            })
            .eq('id', logId)
            .then(r => r),
          `${jobName}:error`
        )
        // Ping healthchecks.io failure (fire-and-forget)
        if (hcSlug) pingHealthcheck(hcSlug, 'fail').catch((err) => {
          logger.warn(`[PipelineLogger] Healthcheck fail ping failed for ${hcSlug}: ${err instanceof Error ? err.message : String(err)}`)
        })
        // Dual-write to ClickHouse (fire-and-forget)
        fireAndForget(
          syncPipelineLog({
            id: logId, job_name: jobName, status: 'error',
            started_at: new Date(startedAt).toISOString(), ended_at: endedAt,
            duration_ms: durationMs, error_message: errorMessage.slice(0, 2000),
            metadata: { ...metadata, ...meta, duration_ms: durationMs },
          }),
          'clickhouse-pipeline-log-error'
        )
        // Auto-alert on error (fire-and-forget, rate-limited per job, 1h cooldown)
        fireAndForget(sendRateLimitedAlert({
          title: `Cron 失败: ${jobName}`,
          message: errorMessage.slice(0, 500),
          level: 'critical',
          details: { job: jobName, duration_ms: durationMs },
        }, `plog:error:${jobName}`, 3_600_000), 'pipeline-logger:error-alert')
      },
      async timeout(meta) {
        const durationMs = Date.now() - startedAt
        const endedAt = new Date().toISOString()
        await withDbTimeout(
          client
            .from('pipeline_logs')
            .update({
              status: 'timeout',
              ended_at: endedAt,
              ...(meta ? { metadata: { ...metadata, ...meta, duration_ms: durationMs } } : { metadata: { ...metadata, duration_ms: durationMs } }),
            })
            .eq('id', logId)
            .then(r => r),
          `${jobName}:timeout`
        )
        // Ping healthchecks.io failure on timeout (fire-and-forget)
        if (hcSlug) pingHealthcheck(hcSlug, 'fail').catch((err) => {
          logger.warn(`[PipelineLogger] Healthcheck fail ping failed for ${hcSlug}: ${err instanceof Error ? err.message : String(err)}`)
        })
        // Dual-write to ClickHouse (fire-and-forget)
        fireAndForget(
          syncPipelineLog({
            id: logId, job_name: jobName, status: 'timeout',
            started_at: new Date(startedAt).toISOString(), ended_at: endedAt,
            duration_ms: durationMs,
            metadata: { ...metadata, ...meta, duration_ms: durationMs },
          }),
          'clickhouse-pipeline-log-timeout'
        )
        // Auto-alert on timeout (fire-and-forget, rate-limited per job, 2h cooldown)
        fireAndForget(sendRateLimitedAlert({
          title: `Cron 超时: ${jobName}`,
          message: `Job ${jobName} timed out after ${Math.round(durationMs / 1000)}s`,
          level: 'warning',
          details: { job: jobName, duration_ms: durationMs },
        }, `plog:timeout:${jobName}`, 7_200_000), 'pipeline-logger:timeout-alert')
      },
    }
  }

  /**
   * Get the latest status for each job (last 24h)
   *
   * ROOT CAUSE FIX (2026-04-09): Previously queried the `pipeline_job_status`
   * VIEW which used `DISTINCT ON (job_name) ORDER BY job_name, started_at DESC`
   * over the entire pipeline_logs table (44k rows). Under cron contention this
   * consistently hit Postgres statement_timeout (>30s). Verified empirically
   * via direct Supabase query (78s parallel for both views).
   *
   * Fix: use the new `get_pipeline_job_statuses_recent()` RPC (migration
   * 20260409173747) which scopes the scan to the last 24h via an explicit
   * WHERE clause, then DISTINCT ON in SQL. Server-side aggregation also
   * bypasses the PostgREST 1000-row cap. Returns ~100 rows in 1-3s.
   */
  static async getJobStatuses(): Promise<Array<{
    job_name: string
    started_at: string
    status: string
    records_processed: number
    error_message: string | null
    health_status: string
  }>> {
    const client = getClient()
    const { data, error } = await client.rpc('get_pipeline_job_statuses_recent')

    if (error) {
      logger.warn(`[PipelineLogger] Failed to get job statuses: ${error.message}`)
      return []
    }
    return (data as Array<{
      job_name: string
      started_at: string
      status: string
      records_processed: number
      error_message: string | null
      health_status: string
    }>) || []
  }

  /**
   * Get job stats for the last 7 days (success rate, error count, avg duration)
   *
   * ROOT CAUSE FIX (2026-04-09): Same root cause as getJobStatuses — the
   * `pipeline_job_stats` view scanned 7 days of pipeline_logs (~10k rows) with
   * GROUP BY + COUNT FILTER aggregates and hit statement_timeout under load.
   *
   * Fix: use the new `get_pipeline_job_stats_recent()` RPC. Returns ~133 rows
   * in 3-5s. Same time bound + GROUP BY but isolated from view contention.
   */
  static async getJobStats(): Promise<Array<{
    job_name: string
    total_runs: number
    success_count: number
    error_count: number
    success_rate: number
    avg_duration_ms: number
    last_run_at: string
  }>> {
    const client = getClient()
    const { data, error } = await client.rpc('get_pipeline_job_stats_recent')

    if (error) {
      logger.warn(`[PipelineLogger] Failed to get job stats: ${error.message}`)
      return []
    }
    return (data as Array<{
      job_name: string
      total_runs: number
      success_count: number
      error_count: number
      success_rate: number
      avg_duration_ms: number
      last_run_at: string
    }>) || []
  }

  /**
   * Get recent failures across all jobs
   *
   * ROOT CAUSE FIX (2026-04-09): Previously had no time filter, so old
   * historical failures (hours/days stale) kept showing up in
   * /api/health/pipeline alerts even after the underlying job recovered.
   * Default 120min window means once a job has been healthy for 2h, its
   * old failures drop out of the alert payload. Callers can pass a custom
   * window if needed (e.g., daily report may want 24h).
   */
  static async getRecentFailures(limit = 20, withinMinutes = 120): Promise<Array<{
    job_name: string
    started_at: string
    error_message: string | null
    metadata: Record<string, unknown>
  }>> {
    const client = getClient()
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString()
    const { data, error } = await client
      .from('pipeline_logs')
      .select('job_name, started_at, error_message, metadata')
      .in('status', ['error', 'timeout'])
      .gte('started_at', cutoff)
      .order('started_at', { ascending: false })
      .limit(limit)

    if (error) {
      logger.warn(`[PipelineLogger] Failed to get recent failures: ${error.message}`)
      return []
    }
    return data || []
  }

  /**
   * Get consecutive failure count for a specific job
   */
  static async getConsecutiveFailures(jobName: string): Promise<number> {
    const client = getClient()
    const { data, error } = await client
      .from('pipeline_logs')
      .select('status')
      .eq('job_name', jobName)
      .order('started_at', { ascending: false })
      .limit(10)

    if (error || !data) return 0

    let count = 0
    for (const row of data) {
      if (row.status === 'error' || row.status === 'timeout') {
        count++
      } else {
        break
      }
    }
    return count
  }
}

function createNoOpHandle(): PipelineLogHandle {
  return {
    id: -1,
    async success(recordsProcessed = 0) {
      logger.warn(`[PipelineLogger:no-op] success — ${recordsProcessed} records processed`)
    },
    async error(err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[PipelineLogger:no-op] error — ${msg}`)
    },
    async partialSuccess(recordsProcessed = 0, failedItems: string[] = []) {
      logger.warn(`[PipelineLogger:no-op] partial_success — ${recordsProcessed} processed, ${failedItems.length} failed`)
    },
    async timeout() {
      logger.warn('[PipelineLogger:no-op] timeout')
    },
  }
}
