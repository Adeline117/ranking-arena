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

import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'

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
  static async start(jobName: string, metadata?: Record<string, unknown>): Promise<PipelineLogHandle> {
    const client = getClient()

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
      return createNoOpHandle()
    }

    const logId = data.id

    return {
      id: logId,
      async success(recordsProcessed = 0, meta) {
        await client
          .from('pipeline_logs')
          .update({
            status: 'success',
            ended_at: new Date().toISOString(),
            records_processed: recordsProcessed,
            ...(meta ? { metadata: { ...metadata, ...meta } } : {}),
          })
          .eq('id', logId)
      },
      async error(err, meta) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        await client
          .from('pipeline_logs')
          .update({
            status: 'error',
            ended_at: new Date().toISOString(),
            error_message: errorMessage.slice(0, 2000),
            ...(meta ? { metadata: { ...metadata, ...meta } } : {}),
          })
          .eq('id', logId)
      },
      async timeout(meta) {
        await client
          .from('pipeline_logs')
          .update({
            status: 'timeout',
            ended_at: new Date().toISOString(),
            ...(meta ? { metadata: { ...metadata, ...meta } } : {}),
          })
          .eq('id', logId)
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
    async success() {},
    async error() {},
    async timeout() {},
  }
}
