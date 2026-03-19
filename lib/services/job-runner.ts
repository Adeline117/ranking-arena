/**
 * Job Runner: processes refresh_jobs from the queue.
 *
 * Architecture:
 * - Polls refresh_jobs table for pending jobs.
 * - Uses FOR UPDATE SKIP LOCKED for atomic dequeue (no double-processing).
 * - Dispatches to appropriate connector method.
 * - Writes results to trader_snapshots_v2, trader_profiles_v2, trader_timeseries.
 * - Handles retries with exponential backoff.
 *
 * Scheduling:
 * - Called from /api/cron/run-jobs or standalone worker.
 * - Top N traders: 15-min interval (priority 1).
 * - Active traders: 1-hour interval (priority 2-3).
 * - On-demand refresh: priority 1 (user-triggered).
 */

import { query, queryOne } from '@/lib/db';
import { getConnector } from '@/lib/connectors/registry';
import { calculateArenaScore, type Period, type ScoreConfidence } from '@/lib/utils/arena-score';
import type {
  Platform,
  GranularPlatform,
  RankingWindow,
  RefreshJob,
  SnapshotMetricsLegacy,
} from '@/lib/types/leaderboard';
import { logger } from '@/lib/logger'

// Derive market_type from platform name for v2 table upserts
function getMarketType(platform: string): 'perp' | 'spot' {
  if (platform.endsWith('_spot')) return 'spot'
  return 'perp'
}

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
  private isRunning = false;

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
          logger.error(`[JobRunner] Job ${job.id} failed: ${errorMsg}`);
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
    return this.enqueueJob('DISCOVER', platform, null, priority);
  }

  /**
   * Enqueue a snapshot refresh for a specific trader.
   */
  async enqueueSnapshot(
    platform: Platform,
    traderKey: string,
    priority: number = 3,
  ): Promise<RefreshJob | null> {
    return this.enqueueJob('SNAPSHOT_REFRESH', platform, traderKey, priority);
  }

  /**
   * Enqueue a full refresh (profile + snapshots + timeseries).
   */
  async enqueueFullRefresh(
    platform: Platform,
    traderKey: string,
    priority: number = 2,
  ): Promise<RefreshJob | null> {
    // Enqueue all three sub-jobs for a full refresh
    await this.enqueueJob('PROFILE_ENRICH', platform, traderKey, priority);
    await this.enqueueJob('TIMESERIES_REFRESH', platform, traderKey, priority);
    // Return the snapshot job as the primary reference
    return this.enqueueJob('SNAPSHOT_REFRESH', platform, traderKey, priority);
  }

  /**
   * Get job status by ID.
   */
  async getJobStatus(jobId: string): Promise<RefreshJob | null> {
    const row = await queryOne(
      `SELECT id, job_type, platform, market_type, trader_key, "window", priority,
              status, attempts, max_attempts, next_run_at, locked_at, locked_by,
              last_error, result, created_at, updated_at, idempotency_key
       FROM refresh_jobs WHERE id = $1`,
      [jobId],
    );
    return row as RefreshJob | null;
  }

  // ============================================
  // Private: Job Execution
  // ============================================

  private async executeJob(job: RefreshJob): Promise<void> {
    const connector = getConnector(job.platform as unknown as GranularPlatform);
    if (!connector) {
      throw new Error(`No connector available for platform: ${job.platform}`);
    }

    switch (job.job_type) {
      case 'DISCOVER':
        await this.runDiscovery(job);
        break;
      case 'SNAPSHOT_REFRESH':
        await this.runSnapshot(job);
        break;
      case 'PROFILE_ENRICH':
        await this.runProfile(job);
        break;
      case 'TIMESERIES_REFRESH':
        await this.runTimeseries(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }
  }

  private async runDiscovery(job: RefreshJob): Promise<void> {
    const connector = getConnector(job.platform as unknown as GranularPlatform)!;
    const windows: RankingWindow[] = ['7d', '30d', '90d'];

    for (const window of windows) {
      const traders = await connector.discoverLeaderboard(window);

      for (const trader of traders) {
        const marketType = getMarketType(trader.platform);
        const now = new Date().toISOString();
        try {
          await query(
            `INSERT INTO trader_sources_v2 (platform, market_type, trader_key, display_name, profile_url, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (platform, market_type, trader_key) DO UPDATE SET
               display_name = COALESCE($4, trader_sources_v2.display_name),
               profile_url = COALESCE($5, trader_sources_v2.profile_url),
               last_seen_at = $6`,
            [trader.platform, marketType, trader.trader_key, trader.display_name, trader.profile_url, now],
          );
        } catch (err: unknown) {
          // If unique constraint is missing, fall back to UPDATE-or-INSERT
          if (err instanceof Error && err.message.includes('ON CONFLICT')) {
            const updated = await query(
              `UPDATE trader_sources_v2 SET
                 display_name = COALESCE($4, display_name),
                 profile_url = COALESCE($5, profile_url),
                 last_seen_at = $6
               WHERE platform = $1 AND market_type = $2 AND trader_key = $3`,
              [trader.platform, marketType, trader.trader_key, trader.display_name, trader.profile_url, now],
            );
            if (!updated.rowCount) {
              await query(
                `INSERT INTO trader_sources_v2 (platform, market_type, trader_key, display_name, profile_url, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [trader.platform, marketType, trader.trader_key, trader.display_name, trader.profile_url, now],
              );
            }
          } else {
            throw err;
          }
        }
      }
    }
  }

  private async runSnapshot(job: RefreshJob): Promise<void> {
    if (!job.trader_key) throw new Error('trader_key required for snapshot job');

    const connector = getConnector(job.platform as unknown as GranularPlatform)!;
    const windows: RankingWindow[] = ['7d', '30d', '90d'];

    for (const window of windows) {
      const snapshot = await connector.fetchTraderSnapshot(job.trader_key, window);
      if (!snapshot) continue;

      const metrics = snapshot.metrics;

      // Calculate Arena Score using legacy metric field names
      const arenaScores = this.calculateScores(metrics, window);
      const enrichedMetrics = {
        ...metrics,
        ...arenaScores,
      };

      const marketType = getMarketType(job.platform);
      await query(
        `INSERT INTO trader_snapshots_v2
           (platform, market_type, trader_key, "window", as_of_ts, metrics, quality,
            arena_score, roi_pct, pnl_usd, max_drawdown_pct, win_rate_pct, trades_count, copier_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (platform, market_type, trader_key, "window", trunc_hour(as_of_ts)) DO UPDATE SET
           metrics = $6, quality = $7, arena_score = $8, roi_pct = $9, pnl_usd = $10,
           max_drawdown_pct = $11, win_rate_pct = $12, trades_count = $13, copier_count = $14`,
        [
          job.platform, marketType, job.trader_key, window, snapshot.as_of_ts,
          JSON.stringify(enrichedMetrics), JSON.stringify(snapshot.quality),
          arenaScores.arena_score, metrics.roi_pct, metrics.pnl_usd,
          metrics.max_drawdown_pct, metrics.win_rate_pct,
          metrics.trades_count, metrics.copier_count,
        ],
      );
    }
  }

  private async runProfile(job: RefreshJob): Promise<void> {
    if (!job.trader_key) throw new Error('trader_key required for profile job');

    const connector = getConnector(job.platform as unknown as GranularPlatform)!;
    const profile = await connector.fetchTraderProfile(job.trader_key);
    if (!profile) throw new Error(`No profile data for ${job.platform}/${job.trader_key}`);

    const marketType = getMarketType(profile.platform);
    await query(
      `INSERT INTO trader_profiles_v2
         (platform, market_type, trader_key, display_name, avatar_url, copier_count, aum_usd, last_enriched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (platform, market_type, trader_key) DO UPDATE SET
         display_name = COALESCE($4, trader_profiles_v2.display_name),
         avatar_url = COALESCE($5, trader_profiles_v2.avatar_url),
         copier_count = COALESCE($6, trader_profiles_v2.copier_count),
         aum_usd = COALESCE($7, trader_profiles_v2.aum_usd),
         last_enriched_at = $8`,
      [profile.platform, marketType, profile.trader_key, profile.display_name, profile.avatar_url,
       profile.copier_count, profile.aum_usd, new Date().toISOString()],
    );
  }

  private async runTimeseries(job: RefreshJob): Promise<void> {
    if (!job.trader_key) throw new Error('trader_key required for timeseries job');

    const connector = getConnector(job.platform as unknown as GranularPlatform)!;
    const seriesTypes = ['equity_curve', 'daily_pnl'] as const;

    for (const seriesType of seriesTypes) {
      const result = await connector.fetchTimeseries(job.trader_key, seriesType);
      if (!result || result.data.length === 0) continue;

      const marketType = getMarketType(result.platform);
      await query(
        `INSERT INTO trader_timeseries (platform, market_type, trader_key, series_type, data, as_of_ts)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (platform, market_type, trader_key, series_type, trunc_hour(as_of_ts)) DO UPDATE SET
           data = $5, as_of_ts = $6`,
        [result.platform, marketType, result.trader_key, result.series_type,
         JSON.stringify(result.data), result.as_of_ts],
      );
    }
  }

  private async runFullRefresh(job: RefreshJob): Promise<void> {
    await this.runProfile(job);
    await this.runSnapshot(job);
    await this.runTimeseries(job);
  }

  // ============================================
  // Private: DB Operations
  // ============================================

  private async claimNextJob(platform?: Platform): Promise<RefreshJob | null> {
    const platformCondition = platform ? `AND platform = '${platform}'` : '';

    const result = await queryOne(
      `UPDATE refresh_jobs
       SET status = 'running', started_at = NOW(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM refresh_jobs
         WHERE status = 'pending' AND next_run_at <= NOW() ${platformCondition}
         ORDER BY priority ASC, next_run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, job_type, platform, market_type, trader_key, "window", priority,
                 status, attempts, max_attempts, next_run_at, locked_at, locked_by,
                 last_error, result, created_at, updated_at, idempotency_key`,
    );

    return result as RefreshJob | null;
  }

  private async completeJob(jobId: string, status: 'completed' | 'failed', error?: string): Promise<void> {
    await query(
      `UPDATE refresh_jobs
       SET status = $2, completed_at = NOW(), last_error = $3
       WHERE id = $1`,
      [jobId, status, error || null],
    );
  }

  private async enqueueJob(
    jobType: string,
    platform: Platform,
    traderKey: string | null,
    priority: number,
  ): Promise<RefreshJob | null> {
    const idempotencyKey = `${jobType}:${platform}:${traderKey || 'all'}:${new Date().toISOString().slice(0, 13)}`;

    try {
      const result = await queryOne(
        `INSERT INTO refresh_jobs (job_type, platform, trader_key, priority, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         ON CONFLICT (idempotency_key) DO UPDATE SET
           status = CASE WHEN refresh_jobs.status = 'completed' THEN 'pending' ELSE refresh_jobs.status END,
           attempts = CASE WHEN refresh_jobs.status = 'completed' THEN 0 ELSE refresh_jobs.attempts END
         RETURNING id, job_type, platform, market_type, trader_key, "window", priority,
                  status, attempts, max_attempts, next_run_at, locked_at, locked_by,
                  last_error, result, created_at, updated_at, idempotency_key`,
        [jobType, platform, traderKey, priority, idempotencyKey],
      );

      return result as RefreshJob | null;
    } catch (err: unknown) {
      // If unique constraint on idempotency_key is missing, fall back to check-then-insert
      if (err instanceof Error && err.message.includes('ON CONFLICT')) {
        const existing = await queryOne(
          `SELECT id, job_type, platform, market_type, trader_key, "window", priority,
                  status, attempts, max_attempts, next_run_at, locked_at, locked_by,
                  last_error, result, created_at, updated_at, idempotency_key
           FROM refresh_jobs WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        if (existing) {
          // Re-enqueue if completed
          if ((existing as unknown as RefreshJob).status === 'completed') {
            await query(
              `UPDATE refresh_jobs SET status = 'pending', attempts = 0 WHERE idempotency_key = $1`,
              [idempotencyKey],
            );
          }
          return existing as unknown as RefreshJob;
        }
        const result = await queryOne(
          `INSERT INTO refresh_jobs (job_type, platform, trader_key, priority, status, idempotency_key)
           VALUES ($1, $2, $3, $4, 'pending', $5)
           RETURNING id, job_type, platform, market_type, trader_key, "window", priority,
                     status, attempts, max_attempts, next_run_at, locked_at, locked_by,
                     last_error, result, created_at, updated_at, idempotency_key`,
          [jobType, platform, traderKey, priority, idempotencyKey],
        );
        return result as RefreshJob | null;
      }
      throw err;
    }
  }

  // ============================================
  // Private: Score Calculation
  // ============================================

  private calculateScores(
    metrics: SnapshotMetricsLegacy,
    window: RankingWindow,
  ): Pick<SnapshotMetricsLegacy, 'arena_score' | 'return_score' | 'drawdown_score' | 'stability_score'> & { score_confidence: ScoreConfidence | null } {
    if (metrics.roi_pct == null) {
      return { arena_score: null, return_score: null, drawdown_score: null, stability_score: null, score_confidence: null };
    }

    const periodMap: Record<RankingWindow, Period> = { '7d': '7D', '30d': '30D', '90d': '90D' };
    const period = periodMap[window];

    try {
      // 传递原始 null 值，让 arena-score 内部使用默认中位值（WR=50%, MDD=-20%）
      const score = calculateArenaScore(
        {
          roi: metrics.roi_pct,
          pnl: metrics.pnl_usd ?? 0,
          maxDrawdown: metrics.max_drawdown_pct ?? null,
          winRate: metrics.win_rate_pct ?? null,
        },
        period,
      );

      return {
        arena_score: score.totalScore ?? null,
        return_score: score.returnScore ?? null,
        drawdown_score: score.drawdownScore ?? null,
        stability_score: score.stabilityScore ?? null,
        score_confidence: score.scoreConfidence,
      };
    } catch {
      return { arena_score: null, return_score: null, drawdown_score: null, stability_score: null, score_confidence: null };
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
  const { rows: topTraders } = await query<{ platform: string; trader_key: string }>(
    `SELECT DISTINCT ON (platform, trader_key) platform, trader_key
     FROM trader_snapshots_v2
     WHERE "window" = '90d' AND arena_score IS NOT NULL
     ORDER BY platform, trader_key, arena_score DESC
     LIMIT $1`,
    [topN],
  );

  if (!topTraders?.length) return 0;

  let enqueued = 0;
  for (const trader of topTraders) {
    await runner.enqueueFullRefresh(trader.platform as Platform, trader.trader_key, 1);
    enqueued++;
  }

  return enqueued;
}
