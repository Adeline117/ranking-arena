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
import { sendAlert } from '@/lib/alerts/send-alert'
import { syncPipelineLog } from '@/lib/analytics/dual-write'
import { pingHealthcheck } from '@/lib/utils/healthcheck'

function getClient() {
  return getSupabaseAdmin()
}

export interface PipelineLogHandle {
  id: number
  success(recordsProcessed?: number, metadata?: Record<string, unknown>): Promise<void>
  error(err: unknown, metadata?: Record<string, unknown>): Promise<void>
  timeout(metadata?: Record<string, unknown>): Promise<void>
}

export class PipelineLogger {
  /** Critical cron jobs that should ping healthchecks.io dead man's switch */
  private static readonly CRITICAL_JOBS = new Set([
    'batch-fetch-traders', 'compute-leaderboard',
    'aggregate-daily-snapshots', 'batch-enrich', 'check-data-freshness',
  ])

  /** Derive healthcheck slug from job name (strip group suffixes like -a, -90D) */
  private static getHealthcheckSlug(jobName: string): string | null {
    for (const critical of this.CRITICAL_JOBS) {
      if (jobName === critical || jobName.startsWith(`${critical}-`)) {
        return critical
      }
    }
    return null
  }

  static async start(jobName: string, metadata?: Record<string, unknown>): Promise<PipelineLogHandle> {
    const client = getClient()

    // Ping healthchecks.io start signal for critical jobs
    const hcSlug = this.getHealthcheckSlug(jobName)
    if (hcSlug) {
      pingHealthcheck(hcSlug, 'start').catch(() => {})
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
      sendAlert({
        title: `PipelineLogger 启动失败: ${jobName}`,
        message: `无法插入 pipeline_logs: ${error?.message || 'unknown error'}\n任务仍会运行，但不会被记录。`,
        level: 'warning',
        details: { jobName, error: error?.message || 'no data returned' },
      }).catch(() => {})
      return createNoOpHandle()
    }

    const logId = data.id
    const startedAt = Date.now()

    return {
      id: logId,
      async success(recordsProcessed = 0, meta) {
        const durationMs = Date.now() - startedAt
        const endedAt = new Date().toISOString()
        await client
          .from('pipeline_logs')
          .update({
            status: 'success',
            ended_at: endedAt,
            records_processed: recordsProcessed,
            ...(meta ? { metadata: { ...metadata, ...meta, duration_ms: durationMs } } : { metadata: { ...metadata, duration_ms: durationMs } }),
          })
          .eq('id', logId)
        // Ping healthchecks.io success (fire-and-forget)
        if (hcSlug) pingHealthcheck(hcSlug, 'success').catch(() => {})
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
      async error(err, meta) {
        const durationMs = Date.now() - startedAt
        const errorMessage = err instanceof Error ? err.message : String(err)
        const endedAt = new Date().toISOString()
        await client
          .from('pipeline_logs')
          .update({
            status: 'error',
            ended_at: endedAt,
            error_message: errorMessage.slice(0, 2000),
            ...(meta ? { metadata: { ...metadata, ...meta, duration_ms: durationMs } } : { metadata: { ...metadata, duration_ms: durationMs } }),
          })
          .eq('id', logId)
        // Ping healthchecks.io failure (fire-and-forget)
        if (hcSlug) pingHealthcheck(hcSlug, 'fail').catch(() => {})
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
      },
      async timeout(meta) {
        const durationMs = Date.now() - startedAt
        const endedAt = new Date().toISOString()
        await client
          .from('pipeline_logs')
          .update({
            status: 'timeout',
            ended_at: endedAt,
            ...(meta ? { metadata: { ...metadata, ...meta, duration_ms: durationMs } } : { metadata: { ...metadata, duration_ms: durationMs } }),
          })
          .eq('id', logId)
        // Ping healthchecks.io failure on timeout (fire-and-forget)
        if (hcSlug) pingHealthcheck(hcSlug, 'fail').catch(() => {})
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
      },
    }
  }

  /**
   * Get the latest status for each job
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
    const { data, error } = await client
      .from('pipeline_job_status')
      .select('job_name, started_at, status, records_processed, error_message, health_status')

    if (error) {
      logger.warn(`[PipelineLogger] Failed to get job statuses: ${error.message}`)
      return []
    }
    return data || []
  }

  /**
   * Get job stats for the last 7 days
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
    const { data, error } = await client
      .from('pipeline_job_stats')
      .select('job_name, total_runs, success_count, error_count, success_rate, avg_duration_ms, last_run_at')

    if (error) {
      logger.warn(`[PipelineLogger] Failed to get job stats: ${error.message}`)
      return []
    }
    return data || []
  }

  /**
   * Get recent failures across all jobs
   */
  static async getRecentFailures(limit = 20): Promise<Array<{
    job_name: string
    started_at: string
    error_message: string | null
    metadata: Record<string, unknown>
  }>> {
    const client = getClient()
    const { data, error } = await client
      .from('pipeline_logs')
      .select('job_name, started_at, error_message, metadata')
      .in('status', ['error', 'timeout'])
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
      console.log(`[PipelineLogger:no-op] success — ${recordsProcessed} records processed`)
    },
    async error(err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[PipelineLogger:no-op] error — ${msg}`)
    },
    async timeout() {
      console.warn('[PipelineLogger:no-op] timeout')
    },
  }
}
