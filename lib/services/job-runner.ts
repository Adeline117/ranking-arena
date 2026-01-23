/**
 * Job Runner: processes refresh_jobs from the queue.
 *
 * Architecture:
 * - Polls refresh_jobs table for pending jobs.
 * - Uses claim_next_refresh_job() for atomic dequeue (no double-processing).
 * - Dispatches to appropriate connector method.
 * - Writes results to trader_snapshots_v2, trader_profiles_v2, trader_timeseries_v2.
 * - Handles retries with exponential backoff (done by DB function).
 *
 * Scheduling:
 * - Called from /api/cron/run-jobs or standalone worker.
 * - Top N traders: 15-min interval (priority 1).
 * - Active traders: 1-hour interval (priority 2-3).
 * - On-demand refresh: priority 1 (user-triggered).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConnector } from '@/lib/connectors/registry';
import { calculateArenaScore, type Period } from '@/lib/utils/arena-score';
import type {
  Platform,
  RankingWindow,
  RefreshJob,
  SnapshotMetrics,
} from '@/lib/types/leaderboard';

// ============================================
// Types
// ============================================

interface JobRunResult {
  processed: number;
  failed: number;
  skipped: number;
}

// ============================================
// Job Runner
// ============================================

export class JobRunner {
  private supabase: SupabaseClient;
  private isRunning = false;

  constructor() {
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }

  /**
   * Process a batch of pending jobs.
   * @param maxJobs Max jobs to process in this batch.
   * @param platform Optional: only process jobs for this platform.
   */
  async processBatch(maxJobs: number = 10, platform?: Platform): Promise<JobRunResult> {
    if (this.isRunning) {
      return { processed: 0, failed: 0, skipped: 0 };
    }

    this.isRunning = true;
    const result: JobRunResult = { processed: 0, failed: 0, skipped: 0 };

    try {
      for (let i = 0; i < maxJobs; i++) {
        const job = await this.claimNextJob(platform);
        if (!job) break; // No more pending jobs

        try {
          await this.executeJob(job);
          await this.completeJob(job.id, 'completed');
          result.processed++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[JobRunner] Job ${job.id} failed: ${errorMsg}`);
          await this.completeJob(job.id, 'failed', errorMsg);
          result.failed++;
        }
      }
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  /**
   * Enqueue a discovery job for a platform.
   */
  async enqueueDiscovery(platform: Platform, priority: number = 3): Promise<RefreshJob | null> {
    return this.enqueueJob('discovery', platform, null, priority);
  }

  /**
   * Enqueue a snapshot refresh for a specific trader.
   */
  async enqueueSnapshot(
    platform: Platform,
    traderKey: string,
    priority: number = 3,
  ): Promise<RefreshJob | null> {
    return this.enqueueJob('snapshot', platform, traderKey, priority);
  }

  /**
   * Enqueue a full refresh (profile + snapshots + timeseries).
   */
  async enqueueFullRefresh(
    platform: Platform,
    traderKey: string,
    priority: number = 2,
  ): Promise<RefreshJob | null> {
    return this.enqueueJob('full_refresh', platform, traderKey, priority);
  }

  /**
   * Get job status by ID.
   */
  async getJobStatus(jobId: string): Promise<RefreshJob | null> {
    const { data } = await this.supabase
      .from('refresh_jobs')
      .select('*')
      .eq('id', jobId)
      .single();
    return data;
  }

  // ============================================
  // Private: Job Execution
  // ============================================

  private async executeJob(job: RefreshJob): Promise<void> {
    const connector = getConnector(job.platform as Platform);
    if (!connector) {
      throw new Error(`No connector available for platform: ${job.platform}`);
    }

    switch (job.job_type) {
      case 'discovery':
        await this.runDiscovery(job);
        break;
      case 'snapshot':
        await this.runSnapshot(job);
        break;
      case 'profile':
        await this.runProfile(job);
        break;
      case 'timeseries':
        await this.runTimeseries(job);
        break;
      case 'full_refresh':
        await this.runFullRefresh(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }
  }

  private async runDiscovery(job: RefreshJob): Promise<void> {
    const connector = getConnector(job.platform as Platform)!;
    const windows: RankingWindow[] = ['7d', '30d', '90d'];

    for (const window of windows) {
      const traders = await connector.discoverLeaderboard(window);

      for (const trader of traders) {
        await this.supabase.from('trader_sources_v2').upsert(
          {
            platform: trader.platform,
            trader_key: trader.trader_key,
            display_name: trader.display_name,
            avatar_url: trader.avatar_url,
            profile_url: trader.profile_url,
            last_seen: new Date().toISOString(),
            is_active: true,
          },
          { onConflict: 'platform,trader_key' },
        );
      }
    }
  }

  private async runSnapshot(job: RefreshJob): Promise<void> {
    if (!job.trader_key) throw new Error('trader_key required for snapshot job');

    const connector = getConnector(job.platform as Platform)!;
    const windows: RankingWindow[] = ['7d', '30d', '90d'];

    for (const window of windows) {
      const snapshot = await connector.fetchTraderSnapshot(job.trader_key, window);

      // Calculate Arena Score
      const arenaScores = this.calculateScores(snapshot.metrics, window);
      const enrichedMetrics: SnapshotMetrics = {
        ...snapshot.metrics,
        ...arenaScores,
      };

      await this.supabase.from('trader_snapshots_v2').upsert(
        {
          platform: snapshot.platform,
          trader_key: snapshot.trader_key,
          window: snapshot.window,
          as_of_ts: snapshot.as_of_ts,
          metrics: enrichedMetrics,
          quality: snapshot.quality,
          // Denormalized fields for fast queries
          arena_score: arenaScores.arena_score,
          roi_pct: snapshot.metrics.roi_pct,
          pnl_usd: snapshot.metrics.pnl_usd,
          max_drawdown_pct: snapshot.metrics.max_drawdown_pct,
          win_rate_pct: snapshot.metrics.win_rate_pct,
          trades_count: snapshot.metrics.trades_count,
          copier_count: snapshot.metrics.copier_count,
        },
        { onConflict: 'platform,trader_key,window,as_of_ts' },
      );
    }
  }

  private async runProfile(job: RefreshJob): Promise<void> {
    if (!job.trader_key) throw new Error('trader_key required for profile job');

    const connector = getConnector(job.platform as Platform)!;
    const profile = await connector.fetchTraderProfile(job.trader_key);

    await this.supabase.from('trader_profiles_v2').upsert(
      {
        ...profile,
        last_enriched_at: new Date().toISOString(),
      },
      { onConflict: 'platform,trader_key' },
    );
  }

  private async runTimeseries(job: RefreshJob): Promise<void> {
    if (!job.trader_key) throw new Error('trader_key required for timeseries job');

    const connector = getConnector(job.platform as Platform)!;
    const seriesTypes: Array<'equity_curve' | 'daily_pnl'> = ['equity_curve', 'daily_pnl'];

    for (const seriesType of seriesTypes) {
      const series = await connector.fetchTimeseries(job.trader_key, seriesType);

      if (series.data.length > 0) {
        await this.supabase.from('trader_timeseries_v2').upsert(
          {
            platform: series.platform,
            trader_key: series.trader_key,
            series_type: series.series_type,
            data: series.data,
            as_of_ts: series.as_of_ts,
          },
          {
            onConflict: 'platform,trader_key,series_type',
            ignoreDuplicates: false,
          },
        );
      }
    }
  }

  private async runFullRefresh(job: RefreshJob): Promise<void> {
    // Full refresh = profile + snapshot + timeseries
    await this.runProfile(job);
    await this.runSnapshot(job);
    await this.runTimeseries(job);
  }

  // ============================================
  // Private: DB Operations
  // ============================================

  private async claimNextJob(platform?: Platform): Promise<RefreshJob | null> {
    const { data, error } = await this.supabase.rpc('claim_next_refresh_job', {
      p_platform: platform || null,
    });

    if (error || !data?.length) return null;
    return data[0] as RefreshJob;
  }

  private async completeJob(jobId: string, status: 'completed' | 'failed', error?: string): Promise<void> {
    await this.supabase.rpc('complete_refresh_job', {
      p_job_id: jobId,
      p_status: status,
      p_error: error || null,
    });
  }

  private async enqueueJob(
    jobType: string,
    platform: Platform,
    traderKey: string | null,
    priority: number,
  ): Promise<RefreshJob | null> {
    const { data, error } = await this.supabase.rpc('enqueue_refresh_job', {
      p_job_type: jobType,
      p_platform: platform,
      p_trader_key: traderKey,
      p_priority: priority,
    });

    if (error) {
      console.error('[JobRunner] Failed to enqueue job:', error);
      return null;
    }
    return data as RefreshJob;
  }

  // ============================================
  // Private: Score Calculation
  // ============================================

  private calculateScores(
    metrics: SnapshotMetrics,
    window: RankingWindow,
  ): Pick<SnapshotMetrics, 'arena_score' | 'return_score' | 'drawdown_score' | 'stability_score'> {
    if (metrics.roi_pct == null) {
      return { arena_score: null, return_score: null, drawdown_score: null, stability_score: null };
    }

    // Map window to the Period format expected by calculateArenaScore
    const periodMap: Record<RankingWindow, Period> = { '7d': '7D', '30d': '30D', '90d': '90D' };
    const period = periodMap[window];

    try {
      const score = calculateArenaScore(
        {
          roi: metrics.roi_pct,
          pnl: metrics.pnl_usd ?? 0,
          maxDrawdown: metrics.max_drawdown_pct ?? 0,
          winRate: metrics.win_rate_pct ?? 50,
        },
        period,
      );

      return {
        arena_score: score.totalScore ?? null,
        return_score: score.returnScore ?? null,
        drawdown_score: score.drawdownScore ?? null,
        stability_score: score.stabilityScore ?? null,
      };
    } catch {
      return { arena_score: null, return_score: null, drawdown_score: null, stability_score: null };
    }
  }
}

// ============================================
// Prewarming Logic
// ============================================

/**
 * Prewarm top traders: enqueue snapshot+profile refresh for high-priority traders.
 * Called from a scheduled cron job.
 */
export async function prewarmTopTraders(runner: JobRunner, topN: number = 100): Promise<number> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Get top traders by arena_score across all platforms
  const { data: topTraders } = await supabase
    .from('trader_snapshots_v2')
    .select('platform, trader_key')
    .eq('window', '90d')
    .not('arena_score', 'is', null)
    .order('arena_score', { ascending: false })
    .limit(topN);

  if (!topTraders?.length) return 0;

  // Deduplicate by (platform, trader_key)
  const seen = new Set<string>();
  let enqueued = 0;

  for (const trader of topTraders) {
    const key = `${trader.platform}:${trader.trader_key}`;
    if (seen.has(key)) continue;
    seen.add(key);

    await runner.enqueueFullRefresh(trader.platform as Platform, trader.trader_key, 1);
    enqueued++;
  }

  return enqueued;
}
