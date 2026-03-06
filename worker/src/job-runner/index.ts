/**
 * Job Runner - Main Entry Point
 *
 * Polls refresh_jobs table and executes jobs using platform connectors.
 * Designed to run as a standalone long-running process.
 *
 * Usage:
 *   npx tsx worker/src/job-runner/index.ts
 *
 * Environment variables required:
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   WORKER_ID - unique identifier for this worker instance (default: random)
 *   POLL_INTERVAL_MS - how often to check for jobs (default: 5000)
 *   BATCH_SIZE - how many jobs to claim at once (default: 1)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { BinanceFuturesConnectorWorker } from './binance-connector.js'
import { BybitFuturesConnectorWorker } from './bybit-connector.js'
import type { ConnectorInterface, RefreshJobRow } from './types.js'
import { logger } from '../logger.js'

// Configuration
const WORKER_ID = process.env.WORKER_ID || `worker-${Math.random().toString(36).slice(2, 8)}`
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000')
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1')
const GRACEFUL_SHUTDOWN_TIMEOUT = 30000

// State
let isRunning = true
let activeJobs = 0

// Supabase client
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

// Connector registry
const connectors: Record<string, ConnectorInterface> = {
  binance_futures: new BinanceFuturesConnectorWorker(),
  bybit: new BybitFuturesConnectorWorker(),
}

/**
 * Main polling loop
 */
async function run(): Promise<void> {
  const db = getSupabase()
  logger.info(`[${WORKER_ID}] Job Runner started. Polling every ${POLL_INTERVAL_MS}ms`)

  while (isRunning) {
    try {
      await pollAndExecute(db)
    } catch (error) {
      logger.error(`[${WORKER_ID}] Poll error`, error instanceof Error ? error : new Error(String(error)))
    }

    // Wait before next poll
    await sleep(POLL_INTERVAL_MS)
  }

  logger.info(`[${WORKER_ID}] Shutting down, waiting for ${activeJobs} active jobs...`)
  const deadline = Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT
  while (activeJobs > 0 && Date.now() < deadline) {
    await sleep(1000)
  }
  logger.info(`[${WORKER_ID}] Shutdown complete.`)
}

/**
 * Poll for pending jobs and execute them
 */
async function pollAndExecute(db: SupabaseClient): Promise<void> {
  // Use the claim_refresh_job function for atomic lock
  const { data: jobs, error } = await db.rpc('claim_refresh_job', {
    p_worker_id: WORKER_ID,
    p_limit: BATCH_SIZE,
  })

  if (error) {
    // Table might not exist yet; don't spam logs
    if (!error.message.includes('does not exist')) {
      logger.error(`[${WORKER_ID}] Failed to claim jobs`, new Error(error.message))
    }
    return
  }

  if (!jobs || jobs.length === 0) return

  logger.info(`[${WORKER_ID}] Claimed ${jobs.length} job(s)`)

  // Execute jobs concurrently (but limited by BATCH_SIZE)
  await Promise.all(jobs.map((job: RefreshJobRow) => executeJob(db, job)))
}

/**
 * Execute a single refresh job
 */
async function executeJob(db: SupabaseClient, job: RefreshJobRow): Promise<void> {
  activeJobs++
  const startTime = Date.now()
  logger.info(`[${WORKER_ID}] Executing job ${job.id}: ${job.job_type} for ${job.platform}/${job.trader_key}`)

  try {
    const connector = connectors[job.platform]
    if (!connector) {
      throw new Error(`No connector available for platform: ${job.platform}`)
    }

    const result: Record<string, unknown> = {}

    // Execute based on job_type
    switch (job.job_type) {
      case 'full_refresh':
        await executeFullRefresh(db, connector, job, result)
        break
      case 'profile_only':
        await executeProfileRefresh(db, connector, job, result)
        break
      case 'snapshot_only':
        await executeSnapshotRefresh(db, connector, job, result)
        break
      case 'timeseries_only':
        await executeTimeseriesRefresh(db, connector, job, result)
        break
      default:
        throw new Error(`Unknown job_type: ${job.job_type}`)
    }

    const duration = Date.now() - startTime
    result.duration_ms = duration

    // Mark job as success
    await db.rpc('complete_refresh_job', {
      p_job_id: job.id,
      p_status: 'success',
      p_result: result,
      p_error: null,
    })

    logger.info(`[${WORKER_ID}] Job ${job.id} completed in ${duration}ms`)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error(`[${WORKER_ID}] Job ${job.id} failed`, error instanceof Error ? error : new Error(String(error)), { jobId: job.id })

    // Mark job as failed (the DB function handles retry logic)
    await db.rpc('complete_refresh_job', {
      p_job_id: job.id,
      p_status: 'failed',
      p_result: null,
      p_error: errorMsg,
    })
  } finally {
    activeJobs--
  }
}

async function executeFullRefresh(
  db: SupabaseClient,
  connector: ConnectorInterface,
  job: RefreshJobRow,
  result: Record<string, unknown>
): Promise<void> {
  // Profile
  await executeProfileRefresh(db, connector, job, result)

  // Snapshots (all windows)
  await executeSnapshotRefresh(db, connector, job, result)

  // Timeseries
  await executeTimeseriesRefresh(db, connector, job, result)
}

async function executeProfileRefresh(
  db: SupabaseClient,
  connector: ConnectorInterface,
  job: RefreshJobRow,
  result: Record<string, unknown>
): Promise<void> {
  const profile = await connector.fetchTraderProfile(job.trader_key)
  if (!profile) {
    result.profile = 'no_data'
    return
  }

  const { error } = await db
    .from('trader_profiles')
    .upsert({
      platform: job.platform,
      trader_key: job.trader_key,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      bio: profile.bio,
      tags: profile.tags || [],
      follower_count: profile.follower_count,
      copier_count: profile.copier_count,
      aum: profile.aum,
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
    }, { onConflict: 'platform,trader_key' })

  if (error) throw new Error(`Profile upsert failed: ${error.message}`)
  result.profile = 'updated'
}

async function executeSnapshotRefresh(
  db: SupabaseClient,
  connector: ConnectorInterface,
  job: RefreshJobRow,
  result: Record<string, unknown>
): Promise<void> {
  const windows: Array<'7D' | '30D' | '90D'> = ['7D', '30D', '90D']
  const snapshotResults: Record<string, string> = {}

  for (const window of windows) {
    try {
      const snapshot = await connector.fetchTraderSnapshot(job.trader_key, window)
      if (!snapshot) {
        snapshotResults[window] = 'no_data'
        continue
      }

      const { error } = await db
        .from('trader_snapshots_v2')
        .upsert({
          platform: job.platform,
          trader_key: job.trader_key,
          window,
          as_of_ts: new Date().toISOString(),
          metrics: snapshot.metrics,
          quality_flags: {
            is_suspicious: snapshot.quality_flags?.is_suspicious ?? false,
            suspicion_reasons: snapshot.quality_flags?.suspicion_reasons ?? [],
            data_completeness: snapshot.quality_flags?.data_completeness ?? 0,
          },
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'platform,trader_key,window,date_trunc(\'hour\', as_of_ts)',
          ignoreDuplicates: true,
        })

      if (error) {
        // Unique constraint violation = idempotent duplicate, not an error
        if (error.code === '23505') {
          snapshotResults[window] = 'duplicate_skipped'
        } else {
          throw new Error(`Snapshot upsert failed for ${window}: ${error.message}`)
        }
      } else {
        snapshotResults[window] = 'updated'
      }
    } catch (err) {
      snapshotResults[window] = `error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  result.snapshots = snapshotResults
}

async function executeTimeseriesRefresh(
  db: SupabaseClient,
  connector: ConnectorInterface,
  job: RefreshJobRow,
  result: Record<string, unknown>
): Promise<void> {
  const seriesData = await connector.fetchTimeseries(job.trader_key)
  if (!seriesData || seriesData.length === 0) {
    result.timeseries = 'no_data'
    return
  }

  const timeseriesResults: Record<string, string> = {}
  for (const series of seriesData) {
    try {
      const { error } = await db
        .from('trader_timeseries')
        .upsert({
          platform: job.platform,
          trader_key: job.trader_key,
          series_type: series.series_type,
          as_of_ts: new Date().toISOString(),
          data: series.data,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'platform,trader_key,series_type,date_trunc(\'hour\', as_of_ts)',
          ignoreDuplicates: true,
        })

      if (error && error.code !== '23505') {
        throw new Error(`Timeseries upsert failed for ${series.series_type}: ${error.message}`)
      }
      timeseriesResults[series.series_type] = error?.code === '23505' ? 'duplicate_skipped' : 'updated'
    } catch (err) {
      timeseriesResults[series.series_type] = `error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  result.timeseries = timeseriesResults
}

// ============================================
// Graceful shutdown
// ============================================
process.on('SIGINT', () => {
  logger.info(`[${WORKER_ID}] Received SIGINT, shutting down...`)
  isRunning = false
})
process.on('SIGTERM', () => {
  logger.info(`[${WORKER_ID}] Received SIGTERM, shutting down...`)
  isRunning = false
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================
// Start
// ============================================
run().catch(err => {
  logger.error('Fatal error in job runner', err instanceof Error ? err : new Error(String(err)))
  process.exit(1)
})
