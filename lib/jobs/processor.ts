/**
 * Job Processor
 *
 * Core job processing engine that:
 * - Claims jobs from the queue atomically
 * - Dispatches to appropriate connectors
 * - Handles success/failure/retry logic
 * - Updates platform rate limit state
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '../supabase/server'
import type {
  RefreshJob,
  JobType,
  LeaderboardPlatform,
  MarketType,
  Window,
} from '../types/leaderboard'
import { connectorRegistry, initializeConnectors } from '../connectors'
import type { PlatformConnector } from '../connectors/types'
import { createLogger } from '../utils/logger'

const jobLogger = createLogger('JobProcessor')

 
type AnySupabaseClient = SupabaseClient<any, any, any>

// ============================================
// Configuration
// ============================================

interface ProcessorConfig {
  /** Worker instance ID (for lock ownership) */
  workerId: string
  /** How many jobs to claim per batch */
  batchSize: number
  /** How long between poll cycles (ms) */
  pollInterval: number
  /** Max time a job can run before considered stale (ms) */
  jobTimeout: number
  /** Platforms this worker handles (null = all) */
  platforms: LeaderboardPlatform[] | null
}

const DEFAULT_CONFIG: ProcessorConfig = {
  workerId: `worker-${process.pid}-${Date.now()}`,
  batchSize: 5,
  pollInterval: 5000,
  jobTimeout: 300000, // 5 minutes
  platforms: null,
}

// ============================================
// Job Processor Class
// ============================================

export class JobProcessor {
  private config: ProcessorConfig
  private supabase: AnySupabaseClient
  private running: boolean = false
  private initialized: boolean = false

  constructor(config?: Partial<ProcessorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    this.supabase = getSupabaseAdmin()
  }

  // ============================================
  // Lifecycle
  // ============================================

  async start(): Promise<void> {
    if (this.running) return

    if (!this.initialized) {
      await initializeConnectors()
      this.initialized = true
    }

    this.running = true
    jobLogger.info(`Started worker ${this.config.workerId}`)

    while (this.running) {
      try {
        await this.processBatch()
      } catch (error) {
        jobLogger.error('Batch error:', error)
      }

      await this.sleep(this.config.pollInterval)
    }
  }

  stop(): void {
    this.running = false
    jobLogger.info(`Stopping worker ${this.config.workerId}`)
  }

  // ============================================
  // Core Processing
  // ============================================

  private async processBatch(): Promise<void> {
    // Release any stale jobs first
    await this.releaseStaleJobs()

    // Claim jobs from queue
    const jobs = await this.claimJobs()
    if (jobs.length === 0) return

    jobLogger.info(`Claimed ${jobs.length} jobs`)

    // Process jobs concurrently (respecting platform limits)
    await Promise.allSettled(
      jobs.map(job => this.processJob(job))
    )
  }

  private async processJob(job: RefreshJob): Promise<void> {
    const startTime = Date.now()
    jobLogger.info(`Processing job ${job.id}: ${job.job_type} ${job.platform}/${job.market_type}/${job.trader_key || '*'}`)

    try {
      // Check circuit breaker
      const isOpen = await this.isCircuitOpen(job.platform, job.market_type)
      if (isOpen) {
        await this.requeueJob(job, 'Circuit breaker open')
        return
      }

      // Get connector
      const connector = await connectorRegistry.getOrInit(job.platform, job.market_type)
      if (!connector) {
        await this.failJob(job, `No connector for ${job.platform}/${job.market_type}`)
        return
      }

      // Dispatch by job type
      switch (job.job_type) {
        case 'DISCOVER':
          await this.handleDiscover(job, connector)
          break
        case 'SNAPSHOT_REFRESH':
          await this.handleSnapshotRefresh(job, connector)
          break
        case 'PROFILE_ENRICH':
          await this.handleProfileEnrich(job, connector)
          break
        case 'TIMESERIES_REFRESH':
          await this.handleTimeseriesRefresh(job, connector)
          break
        default:
          await this.failJob(job, `Unknown job type: ${job.job_type}`)
          return
      }

      // Mark success
      const duration = Date.now() - startTime
      await this.completeJob(job, { duration_ms: duration })
      await this.recordPlatformSuccess(job.platform, job.market_type)

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      jobLogger.error(`Job ${job.id} failed:`, errorMessage)

      await this.recordPlatformFailure(job.platform, job.market_type)

      if (job.attempts >= job.max_attempts) {
        await this.failJob(job, errorMessage)
      } else {
        await this.requeueJob(job, errorMessage)
      }
    }
  }

  // ============================================
  // Job Type Handlers
  // ============================================

  /** @deprecated Writes to trader_sources directly. Not migratable to unified (write operation). */
  private async handleDiscover(job: RefreshJob, connector: PlatformConnector): Promise<void> {
    const window = (job.window || '30d') as Window
    const result = await connector.discoverLeaderboard(window, 200)

    if (result.traders.length === 0) return

    // Upsert trader sources
    const rows = result.traders.map(t => ({
      source: t.platform,
      source_trader_id: t.trader_key,
      market_type: t.market_type,
      handle: t.display_name,
      display_name: t.display_name,
      profile_url: t.profile_url,
      discovered_at: t.discovered_at,
      last_seen_at: t.last_seen_at,
      is_active: t.is_active,
      raw: t.raw,
    }))

    const { error } = await this.supabase
      .from('trader_sources')
      .upsert(rows, {
        onConflict: 'source,market_type,source_trader_id',
        ignoreDuplicates: false,
      })

    if (error) throw new Error(`Upsert trader_sources failed: ${error.message}`)

    jobLogger.info(`[Discover] ${job.platform}/${job.market_type}: found ${result.traders.length} traders`)
  }

  /** @deprecated Writes to trader_snapshots directly. Not migratable to unified (write operation). */
  private async handleSnapshotRefresh(job: RefreshJob, connector: PlatformConnector): Promise<void> {
    if (!job.trader_key) throw new Error('SNAPSHOT_REFRESH requires trader_key')
    if (!job.window) throw new Error('SNAPSHOT_REFRESH requires window')

    const window = job.window as Window
    const result = await connector.fetchTraderSnapshot(job.trader_key, window)

    if (!result) {
      // No data available - record quality flag but don't fail
      jobLogger.info(`[Snapshot] No data for ${job.platform}/${job.trader_key}/${window}`)
      return
    }

    const now = new Date().toISOString()
    const windowUpper = job.window?.toUpperCase() || '90D'

    // Upsert to trader_snapshots_v2 (PRIMARY — read by compute-leaderboard)
    const { error: v2Error } = await this.supabase
      .from('trader_snapshots_v2')
      .upsert({
        platform: job.platform,
        market_type: job.market_type,
        trader_key: job.trader_key,
        window: windowUpper,
        as_of_ts: now,
        roi_pct: result.metrics.roi ?? null,
        pnl_usd: result.metrics.pnl ?? null,
        win_rate: result.metrics.win_rate ?? null,
        max_drawdown: result.metrics.max_drawdown ?? null,
        arena_score: result.metrics.arena_score ?? null,
        sharpe_ratio: result.metrics.sharpe_ratio ?? null,
        trades_count: result.metrics.trades_count ?? null,
        followers: null,
        copiers: null,
        metrics: result.metrics,
        quality_flags: result.quality_flags,
        updated_at: now,
      }, {
        onConflict: 'platform,market_type,trader_key,window,as_of_ts',
      })

    if (v2Error && v2Error.code !== '23505') {
      throw new Error(`Upsert trader_snapshots_v2 failed: ${v2Error.message}`)
    }

    // Also upsert to trader_snapshots (v1) for legacy compatibility
    const { error: v1Error } = await this.supabase
      .from('trader_snapshots')
      .upsert({
        source: job.platform,
        source_trader_id: job.trader_key,
        market_type: job.market_type,
        window: job.window,
        season_id: windowUpper,
        as_of_ts: now,
        roi: result.metrics.roi,
        pnl: result.metrics.pnl,
        win_rate: result.metrics.win_rate,
        max_drawdown: result.metrics.max_drawdown,
        followers: result.metrics.followers,
        trades_count: result.metrics.trades_count,
        arena_score: result.metrics.arena_score,
        return_score: result.metrics.return_score,
        drawdown_score: result.metrics.drawdown_score,
        stability_score: result.metrics.stability_score,
        sharpe_ratio: result.metrics.sharpe_ratio,
        sortino_ratio: result.metrics.sortino_ratio,
        copiers: result.metrics.copiers,
        aum: result.metrics.aum,
        platform_rank: result.metrics.platform_rank,
        metrics: result.metrics,
        quality_flags: result.quality_flags,
        captured_at: now,
      }, {
        onConflict: 'source,market_type,source_trader_id,window,as_of_ts',
      })

    if (v1Error && v1Error.code !== '23505') {
      jobLogger.warn(`[Snapshot] v1 upsert failed (non-critical): ${v1Error.message}`)
    }

    jobLogger.info(`[Snapshot] Updated ${job.platform}/${job.trader_key}/${window}: score=${result.metrics.arena_score}`)
  }

  private async handleProfileEnrich(job: RefreshJob, connector: PlatformConnector): Promise<void> {
    if (!job.trader_key) throw new Error('PROFILE_ENRICH requires trader_key')

    const result = await connector.fetchTraderProfile(job.trader_key)
    if (!result) return

    const { error } = await this.supabase
      .from('trader_profiles')
      .upsert({
        platform: job.platform,
        market_type: job.market_type,
        trader_key: job.trader_key,
        display_name: result.profile.display_name,
        avatar_url: result.profile.avatar_url,
        bio: result.profile.bio,
        tags: result.profile.tags,
        profile_url: result.profile.profile_url,
        followers: result.profile.followers,
        copiers: result.profile.copiers,
        aum: result.profile.aum,
        last_enriched_at: new Date().toISOString(),
        provenance: result.profile.provenance,
      }, {
        onConflict: 'platform,market_type,trader_key',
      })

    if (error) throw new Error(`Upsert profile failed: ${error.message}`)

    jobLogger.info(`[Profile] Enriched ${job.platform}/${job.trader_key}`)
  }

  private async handleTimeseriesRefresh(job: RefreshJob, connector: PlatformConnector): Promise<void> {
    if (!job.trader_key) throw new Error('TIMESERIES_REFRESH requires trader_key')

    const result = await connector.fetchTimeseries(job.trader_key)
    if (result.series.length === 0) return

    // Batch upsert instead of loop
    const records = result.series.map(ts => ({
      platform: job.platform,
      market_type: job.market_type,
      trader_key: job.trader_key,
      series_type: ts.series_type,
      as_of_ts: ts.as_of_ts,
      data: ts.data,
    }))

    const BATCH_SIZE = 25
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE)
      const { error } = await this.supabase
        .from('trader_timeseries')
        .upsert(batch, {
          onConflict: 'platform,market_type,trader_key,series_type',
        })

      if (error) {
        jobLogger.error(`Batch ${i} failed:`, error)
        throw new Error(`Upsert timeseries failed: ${error.message}`)
      }
    }

    jobLogger.info(`[Timeseries] Updated ${result.series.length} series for ${job.platform}/${job.trader_key}`)
  }

  // ============================================
  // Queue Operations
  // ============================================

  private async claimJobs(): Promise<RefreshJob[]> {
    const { data, error } = await this.supabase
      .rpc('claim_refresh_job', {
        p_worker_id: this.config.workerId,
        p_platforms: this.config.platforms,
        p_batch_size: this.config.batchSize,
      })

    if (error) {
      jobLogger.error('Failed to claim jobs:', error.message)
      return []
    }

    return (data || []) as RefreshJob[]
  }

  private async completeJob(job: RefreshJob, result: Record<string, unknown>): Promise<void> {
    await this.supabase
      .from('refresh_jobs')
      .update({
        status: 'completed',
        result,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }

  private async failJob(job: RefreshJob, error: string): Promise<void> {
    await this.supabase
      .from('refresh_jobs')
      .update({
        status: 'failed',
        last_error: error,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }

  private async requeueJob(job: RefreshJob, error: string): Promise<void> {
    // Exponential backoff: 30s, 60s, 120s, 240s...
    const backoffMs = 30000 * Math.pow(2, job.attempts)
    const nextRun = new Date(Date.now() + backoffMs).toISOString()

    await this.supabase
      .from('refresh_jobs')
      .update({
        status: 'pending',
        locked_at: null,
        locked_by: null,
        next_run_at: nextRun,
        last_error: error,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  }

  private async releaseStaleJobs(): Promise<void> {
    const { data } = await this.supabase.rpc('release_stale_jobs', {
      p_stale_threshold: '5 minutes',
    })
    if (data && data > 0) {
      jobLogger.info(`Released ${data} stale jobs`)
    }
  }

  // ============================================
  // Circuit Breaker
  // ============================================

  private async isCircuitOpen(platform: string, marketType: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('platform_rate_limits')
      .select('cooldown_until, consecutive_failures')
      .eq('platform', platform)
      .eq('market_type', marketType)
      .single()

    if (!data) return false

    if (data.cooldown_until && new Date(data.cooldown_until) > new Date()) {
      return true
    }

    return data.consecutive_failures >= 5
  }

  private async recordPlatformSuccess(platform: string, marketType: string): Promise<void> {
    await this.supabase
      .from('platform_rate_limits')
      .update({
        consecutive_failures: 0,
        cooldown_until: null,
        last_success_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('platform', platform)
      .eq('market_type', marketType)
  }

  private async recordPlatformFailure(platform: string, marketType: string): Promise<void> {
    const { data } = await this.supabase
      .from('platform_rate_limits')
      .select('consecutive_failures')
      .eq('platform', platform)
      .eq('market_type', marketType)
      .single()

    const failures = (data?.consecutive_failures || 0) + 1
    const cooldownUntil = failures >= 5
      ? new Date(Date.now() + 60000 * failures).toISOString()  // 1min per failure
      : null

    await this.supabase
      .from('platform_rate_limits')
      .update({
        consecutive_failures: failures,
        cooldown_until: cooldownUntil,
        last_failure_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('platform', platform)
      .eq('market_type', marketType)
  }

  // ============================================
  // Utility
  // ============================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// ============================================
// Job Creation Helpers
// ============================================

/**
 * Create a refresh job in the queue.
 * Idempotent: duplicate pending/running jobs are ignored.
 */
export async function createRefreshJob(params: {
  jobType: JobType
  platform: LeaderboardPlatform
  marketType: MarketType
  traderKey?: string
  window?: Window
  priority?: number
}): Promise<string | null> {
  const supabase: AnySupabaseClient = getSupabaseAdmin()

  const { data, error } = await supabase
    .from('refresh_jobs')
    .insert({
      job_type: params.jobType,
      platform: params.platform,
      market_type: params.marketType,
      trader_key: params.traderKey || null,
      window: params.window || null,
      priority: params.priority || 30,
      status: 'pending',
      next_run_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    // Duplicate job (dedup index) - not an error
    if (error.code === '23505') {
      return null
    }
    jobLogger.error('[createRefreshJob] Error:', error.message)
    return null
  }

  return data?.id || null
}

/**
 * Create a batch of preheat jobs for top N traders on a platform.
 * @deprecated Reads trader_sources for source_trader_id list. Uses scheduling-specific
 *             columns (is_active) not available in unified layer.
 */
export async function createPreheatJobs(
  platform: LeaderboardPlatform,
  marketType: MarketType,
  topN: number = 500
): Promise<number> {
  const supabase: AnySupabaseClient = getSupabaseAdmin()

  // Get top N traders by arena_score
  const { data: traders } = await supabase
    .from('trader_sources')
    .select('source_trader_id')
    .eq('source', platform)
    .eq('market_type', marketType)
    .eq('is_active', true)
    .limit(topN)

  if (!traders || traders.length === 0) return 0

  const windows: Window[] = ['7d', '30d', '90d']
  let created = 0

  for (const trader of traders) {
    for (const window of windows) {
      const id = await createRefreshJob({
        jobType: 'SNAPSHOT_REFRESH',
        platform,
        marketType,
        traderKey: trader.source_trader_id,
        window,
        priority: 20, // TOP_N_PREHEAT
      })
      if (id) created++
    }
  }

  return created
}
