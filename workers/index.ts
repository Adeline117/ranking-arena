// @ts-nocheck - Supabase tables not in generated types (v2 schema)
/**
 * Queue Worker - Main Entry Point
 *
 * Processes refresh_jobs queue with:
 * - Per-platform rate limiting
 * - Retry with exponential backoff
 * - Circuit breaker per platform
 * - Priority-based job picking
 * - Idempotent writes with locking
 *
 * Usage:
 *   npx tsx workers/index.ts
 *   # Or with env vars:
 *   WORKER_ID=worker-1 PLATFORMS=binance,bybit npx tsx workers/index.ts
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConnector, getRankingConnectorKeys } from '../connectors';
import type {
  Platform, MarketType, Window, JobType,
  RefreshJob, CanonicalSnapshot, LeaderboardEntry,
} from '../connectors/base/types';
import { CircuitBreaker } from './circuit-breaker';
import { RateLimiter } from './rate-limiter';
import { calculateArenaScore } from './arena-score';

// ============================================
// Configuration
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const WORKER_ID = process.env.WORKER_ID || `worker-${Date.now()}`;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3');
const TARGET_PLATFORMS = process.env.PLATFORMS
  ? process.env.PLATFORMS.split(',') as Platform[]
  : null; // null = all platforms

// ============================================
// State
// ============================================

const circuitBreakers = new Map<string, CircuitBreaker>();
const rateLimiters = new Map<string, RateLimiter>();
let running = true;
let activeJobs = 0;

// ============================================
// Main Loop
// ============================================

async function main() {
  console.log(`[${WORKER_ID}] Starting worker...`);
  console.log(`[${WORKER_ID}] Poll interval: ${POLL_INTERVAL}ms, Max concurrent: ${MAX_CONCURRENT}`);
  if (TARGET_PLATFORMS) {
    console.log(`[${WORKER_ID}] Target platforms: ${TARGET_PLATFORMS.join(', ')}`);
  }

  // Release stale locks on startup
  await releaseStaleJobs();

  // Main poll loop
  while (running) {
    try {
      if (activeJobs < MAX_CONCURRENT) {
        const job = await claimNextJob();
        if (job) {
          activeJobs++;
          processJob(job).finally(() => { activeJobs--; });
        }
      }
    } catch (error) {
      console.error(`[${WORKER_ID}] Poll error:`, error);
    }

    await sleep(POLL_INTERVAL);
  }

  console.log(`[${WORKER_ID}] Shutting down...`);
}

// ============================================
// Job Processing
// ============================================

async function claimNextJob(): Promise<RefreshJob | null> {
  const { data, error } = await supabase.rpc('claim_refresh_job', {
    p_worker_id: WORKER_ID,
    p_platforms: TARGET_PLATFORMS,
    p_job_types: null,
  });

  if (error) {
    console.error(`[${WORKER_ID}] Claim error:`, error.message);
    return null;
  }

  return data?.[0] || null;
}

async function processJob(job: RefreshJob): Promise<void> {
  const platformKey = `${job.platform}:${job.market_type}`;
  console.log(`[${WORKER_ID}] Processing ${job.job_type} job for ${platformKey} (attempt ${job.attempts})`);

  // Check circuit breaker
  const breaker = getCircuitBreaker(job.platform);
  if (!breaker.canExecute()) {
    console.log(`[${WORKER_ID}] Circuit open for ${job.platform}, deferring job`);
    await deferJob(job, 'Circuit breaker open');
    return;
  }

  // Enforce rate limit
  const limiter = getRateLimiter(job.platform);
  await limiter.waitForSlot();

  try {
    switch (job.job_type as JobType) {
      case 'DISCOVER':
        await handleDiscoverJob(job);
        break;
      case 'SNAPSHOT':
        await handleSnapshotJob(job);
        break;
      case 'PROFILE':
        await handleProfileJob(job);
        break;
      case 'TIMESERIES':
        await handleTimeseriesJob(job);
        break;
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }

    // Success
    breaker.recordSuccess();
    await completeJob(job);
  } catch (error) {
    const errorMsg = (error as Error).message || String(error);
    console.error(`[${WORKER_ID}] Job failed:`, errorMsg);

    breaker.recordFailure();
    await failJob(job, errorMsg);
  }
}

// ============================================
// Job Handlers
// ============================================

async function handleDiscoverJob(job: RefreshJob): Promise<void> {
  const connector = getConnector(job.platform as Platform, job.market_type as MarketType);
  if (!connector) throw new Error(`No connector for ${job.platform}:${job.market_type}`);

  const windows: Window[] = ['7d', '30d', '90d'];

  for (const window of windows) {
    const result = await connector.discoverLeaderboard(window, 100);

    if (!result.success || !result.data?.length) {
      console.log(`[${WORKER_ID}] No data for ${job.platform}:${window}: ${result.error || 'empty'}`);
      continue;
    }

    console.log(`[${WORKER_ID}] Discovered ${result.data.length} traders for ${job.platform}:${window}`);

    // Upsert sources
    await upsertTraderSources(job.platform as Platform, job.market_type as MarketType, result.data);

    // Upsert snapshots from leaderboard data
    await upsertLeaderboardSnapshots(
      job.platform as Platform,
      job.market_type as MarketType,
      window,
      result.data,
      result.provenance,
    );

    // Rate limit between windows
    await sleep(2000);
  }
}

async function handleSnapshotJob(job: RefreshJob): Promise<void> {
  if (!job.trader_key) throw new Error('SNAPSHOT job requires trader_key');

  const connector = getConnector(job.platform as Platform, job.market_type as MarketType);
  if (!connector) throw new Error(`No connector for ${job.platform}:${job.market_type}`);

  const windows: Window[] = ['7d', '30d', '90d'];

  for (const window of windows) {
    const result = await connector.fetchTraderSnapshot(job.trader_key, window);
    if (result.success && result.data) {
      await upsertSnapshot(result.data);
    }
    await sleep(1000);
  }
}

async function handleProfileJob(job: RefreshJob): Promise<void> {
  if (!job.trader_key) throw new Error('PROFILE job requires trader_key');

  const connector = getConnector(job.platform as Platform, job.market_type as MarketType);
  if (!connector) throw new Error(`No connector for ${job.platform}:${job.market_type}`);

  const result = await connector.fetchTraderProfile(job.trader_key);
  if (result.success && result.data) {
    await upsertProfile(result.data);
  }
}

async function handleTimeseriesJob(job: RefreshJob): Promise<void> {
  if (!job.trader_key) throw new Error('TIMESERIES job requires trader_key');

  const connector = getConnector(job.platform as Platform, job.market_type as MarketType);
  if (!connector) throw new Error(`No connector for ${job.platform}:${job.market_type}`);

  const result = await connector.fetchTimeseries(job.trader_key);
  if (result.success && result.data) {
    for (const ts of result.data) {
      await upsertTimeseries(ts);
    }
  }
}

// ============================================
// Database Operations
// ============================================

async function upsertTraderSources(
  platform: Platform,
  market_type: MarketType,
  entries: LeaderboardEntry[]
): Promise<void> {
  const records = entries.map(entry => ({
    platform,
    market_type,
    trader_key: entry.trader_key,
    display_name: entry.display_name,
    profile_url: entry.profile_url,
    last_seen_at: new Date().toISOString(),
    is_active: true,
    raw: entry.raw,
  }));

  const { error } = await supabase
    .from('trader_sources_v2')
    .upsert(records, { onConflict: 'platform,market_type,trader_key' });

  if (error) console.error(`[${WORKER_ID}] Upsert sources error:`, error.message);
}

async function upsertLeaderboardSnapshots(
  platform: Platform,
  market_type: MarketType,
  window: Window,
  entries: LeaderboardEntry[],
  provenance: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();

  const records = entries
    .filter(e => e.metrics.roi_pct != null || Object.keys(e.metrics).length > 0)
    .map(entry => {
      const roi = entry.metrics.roi_pct ?? null;
      const pnl = entry.metrics.pnl_usd ?? null;
      const winRate = entry.metrics.win_rate ?? null;
      const maxDrawdown = entry.metrics.max_drawdown ?? null;

      // Calculate arena score
      const arenaScore = roi != null
        ? calculateArenaScore(roi, pnl, maxDrawdown, winRate, window)
        : null;

      return {
        platform,
        market_type,
        trader_key: entry.trader_key,
        window,
        as_of_ts: now,
        metrics: entry.metrics,
        roi_pct: roi,
        pnl_usd: pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        trades_count: entry.metrics.trades_count ?? null,
        followers: entry.metrics.followers ?? null,
        copiers: entry.metrics.copiers ?? null,
        sharpe_ratio: entry.metrics.sharpe_ratio ?? null,
        arena_score: arenaScore,
        quality_flags: {
          missing_roi: roi == null,
          missing_pnl: pnl == null,
          platform_default_sort: provenance.platform_sorting === 'default',
        },
        provenance,
      };
    });

  if (records.length === 0) return;

  // Batch upsert in chunks of 50
  for (let i = 0; i < records.length; i += 50) {
    const chunk = records.slice(i, i + 50);
    const { error } = await supabase
      .from('trader_snapshots_v2')
      .upsert(chunk, {
        onConflict: 'platform,market_type,trader_key,window,date_trunc_hour_as_of_ts',
        ignoreDuplicates: true,
      });

    if (error) {
      // Fallback: insert one by one
      for (const record of chunk) {
        const { error: singleError } = await supabase
          .from('trader_snapshots_v2')
          .insert(record);
        if (singleError && !singleError.message.includes('duplicate')) {
          console.error(`[${WORKER_ID}] Insert snapshot error:`, singleError.message);
        }
      }
    }
  }
}

async function upsertSnapshot(snapshot: CanonicalSnapshot): Promise<void> {
  const arenaScore = snapshot.metrics.roi_pct != null
    ? calculateArenaScore(
        snapshot.metrics.roi_pct,
        snapshot.metrics.pnl_usd,
        snapshot.metrics.max_drawdown,
        snapshot.metrics.win_rate,
        snapshot.window,
      )
    : null;

  const { error } = await supabase
    .from('trader_snapshots_v2')
    .insert({
      ...snapshot,
      roi_pct: snapshot.metrics.roi_pct,
      pnl_usd: snapshot.metrics.pnl_usd,
      win_rate: snapshot.metrics.win_rate,
      max_drawdown: snapshot.metrics.max_drawdown,
      trades_count: snapshot.metrics.trades_count,
      followers: snapshot.metrics.followers,
      copiers: snapshot.metrics.copiers,
      sharpe_ratio: snapshot.metrics.sharpe_ratio,
      arena_score: arenaScore,
    });

  if (error && !error.message.includes('duplicate')) {
    console.error(`[${WORKER_ID}] Upsert snapshot error:`, error.message);
  }
}

async function upsertProfile(profile: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('trader_profiles_v2')
    .upsert(profile, { onConflict: 'platform,market_type,trader_key' });

  if (error) console.error(`[${WORKER_ID}] Upsert profile error:`, error.message);
}

async function upsertTimeseries(ts: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('trader_timeseries')
    .insert(ts);

  if (error && !error.message.includes('duplicate')) {
    console.error(`[${WORKER_ID}] Insert timeseries error:`, error.message);
  }
}

// ============================================
// Job State Management
// ============================================

async function completeJob(job: RefreshJob): Promise<void> {
  await supabase
    .from('refresh_jobs')
    .update({
      status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Update platform health
  await supabase
    .from('platform_health')
    .upsert({
      platform: job.platform,
      status: 'healthy',
      consecutive_failures: 0,
      last_success_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'platform' });
}

async function failJob(job: RefreshJob, error: string): Promise<void> {
  const isDeadletter = job.attempts >= job.max_attempts;
  const backoffMs = Math.min(60000, 5000 * Math.pow(2, job.attempts));

  await supabase
    .from('refresh_jobs')
    .update({
      status: isDeadletter ? 'dead' : 'failed',
      last_error: error,
      next_run_at: new Date(Date.now() + backoffMs).toISOString(),
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Update platform health
  const { data: health } = await supabase
    .from('platform_health')
    .select('consecutive_failures')
    .eq('platform', job.platform)
    .single();

  const failures = (health?.consecutive_failures || 0) + 1;
  const status = failures >= 5 ? 'circuit_open' : failures >= 3 ? 'degraded' : 'healthy';

  await supabase
    .from('platform_health')
    .upsert({
      platform: job.platform,
      status,
      consecutive_failures: failures,
      last_failure_at: new Date().toISOString(),
      last_error: error,
      circuit_opened_at: status === 'circuit_open' ? new Date().toISOString() : null,
      circuit_closes_at: status === 'circuit_open' ? new Date(Date.now() + 300000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'platform' });
}

async function deferJob(job: RefreshJob, reason: string): Promise<void> {
  await supabase
    .from('refresh_jobs')
    .update({
      status: 'pending',
      locked_at: null,
      locked_by: null,
      next_run_at: new Date(Date.now() + 60000).toISOString(),
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
}

async function releaseStaleJobs(): Promise<void> {
  const { data } = await supabase.rpc('release_stale_locks');
  if (data && data > 0) {
    console.log(`[${WORKER_ID}] Released ${data} stale jobs`);
  }
}

// ============================================
// Circuit Breaker & Rate Limiter
// ============================================

function getCircuitBreaker(platform: string): CircuitBreaker {
  if (!circuitBreakers.has(platform)) {
    circuitBreakers.set(platform, new CircuitBreaker(platform, {
      failureThreshold: 5,
      resetTimeout: 300000, // 5 minutes
    }));
  }
  return circuitBreakers.get(platform)!;
}

function getRateLimiter(platform: string): RateLimiter {
  if (!rateLimiters.has(platform)) {
    rateLimiters.set(platform, new RateLimiter(platform, {
      rpm: 15,
      concurrent: 2,
    }));
  }
  return rateLimiters.get(platform)!;
}

// ============================================
// Utilities
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Seed Jobs (for initial discovery)
// ============================================

export async function seedDiscoveryJobs(): Promise<void> {
  const keys = getRankingConnectorKeys();

  for (const key of keys) {
    const [platform, market_type] = key.split(':') as [Platform, MarketType];

    const { error } = await supabase
      .from('refresh_jobs')
      .upsert({
        job_type: 'DISCOVER',
        platform,
        market_type,
        priority: 10,
        status: 'pending',
        next_run_at: new Date().toISOString(),
      }, { onConflict: 'platform,market_type,job_type' });

    if (error) console.error(`Seed job error for ${key}:`, error.message);
  }

  console.log(`Seeded ${keys.length} discovery jobs`);
}

// ============================================
// Graceful Shutdown
// ============================================

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

// ============================================
// Entry Point
// ============================================

if (process.argv[1]?.endsWith('workers/index.ts') || process.argv[1]?.endsWith('workers/index.js')) {
  if (process.argv.includes('--seed')) {
    seedDiscoveryJobs().then(() => process.exit(0));
  } else {
    main().catch(err => {
      console.error('Worker fatal error:', err);
      process.exit(1);
    });
  }
}

export { main as startWorker };
