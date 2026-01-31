// Note: Some Supabase tables may not be in generated types - using 'as any' where needed
/**
 * Cron endpoint: Run worker inline (for Vercel serverless deployment)
 *
 * Processes up to N pending jobs per invocation.
 * This is the Vercel-compatible worker alternative.
 *
 * Schedule: Every 5 minutes (see vercel.json)
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getConnector } from '@/connectors';
import { calculateArenaScore } from '@/workers/arena-score';
import type { Platform, MarketType, Window, LeaderboardEntry } from '@/connectors/base/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 60 seconds max for Vercel

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_JOBS_PER_RUN = 3;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (!SUPABASE_KEY) {
      return NextResponse.json({ error: 'Service not configured' }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const workerId = `vercel-${Date.now()}`;
    const results: Array<{ job_id: string; platform: string; status: string; error?: string }> = [];

    // Process up to MAX_JOBS_PER_RUN
    for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
      // Claim next job
      const { data: jobs } = await supabase.rpc('claim_refresh_job', {
        p_worker_id: workerId,
        p_platforms: null,
        p_job_types: null,
      });

      const job = jobs?.[0];
      if (!job) break; // No more jobs

      try {
        // Check platform health
        const { data: health } = await supabase
          .from('platform_health')
          .select('status')
          .eq('platform', job.platform)
          .single();

        if (health?.status === 'circuit_open') {
          await supabase
            .from('refresh_jobs')
            .update({
              status: 'pending',
              locked_at: null,
              locked_by: null,
              next_run_at: new Date(Date.now() + 300000).toISOString(),
              last_error: 'Circuit breaker open',
            })
            .eq('id', job.id);

          results.push({ job_id: job.id, platform: job.platform, status: 'deferred', error: 'Circuit open' });
          continue;
        }

        // Process the job
        const connector = getConnector(job.platform as Platform, job.market_type as MarketType);
        if (!connector) throw new Error(`No connector for ${job.platform}:${job.market_type}`);

        if (job.job_type === 'DISCOVER') {
          const windows: Window[] = ['7d', '30d', '90d'];
          for (const window of windows) {
            const result = await connector.discoverLeaderboard(window, 100);
            if (result.success && result.data?.length) {
              await upsertLeaderboardData(supabase, job.platform as Platform, job.market_type as MarketType, window, result.data, result.provenance);
            }
          }
        } else if (job.job_type === 'SNAPSHOT' && job.trader_key) {
          const windows: Window[] = ['7d', '30d', '90d'];
          for (const window of windows) {
            const result = await connector.fetchTraderSnapshot(job.trader_key, window);
            if (result.success && result.data) {
              const arenaScore = result.data.metrics.roi_pct != null
                ? calculateArenaScore(result.data.metrics.roi_pct, result.data.metrics.pnl_usd, result.data.metrics.max_drawdown, result.data.metrics.win_rate, window)
                : null;

              await supabase.from('trader_snapshots_v2').insert({
                ...result.data,
                roi_pct: result.data.metrics.roi_pct,
                pnl_usd: result.data.metrics.pnl_usd,
                win_rate: result.data.metrics.win_rate,
                max_drawdown: result.data.metrics.max_drawdown,
                trades_count: result.data.metrics.trades_count,
                followers: result.data.metrics.followers,
                copiers: result.data.metrics.copiers,
                sharpe_ratio: result.data.metrics.sharpe_ratio,
                arena_score: arenaScore,
              });
            }
          }
        } else if (job.job_type === 'PROFILE' && job.trader_key) {
          const result = await connector.fetchTraderProfile(job.trader_key);
          if (result.success && result.data) {
            await supabase.from('trader_profiles_v2').upsert(result.data, { onConflict: 'platform,market_type,trader_key' });
          }
        }

        // Mark complete
        await supabase
          .from('refresh_jobs')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', job.id);

        // Update platform health
        await supabase.from('platform_health').upsert({
          platform: job.platform,
          status: 'healthy',
          consecutive_failures: 0,
          last_success_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'platform' });

        results.push({ job_id: job.id, platform: job.platform, status: 'completed' });
      } catch (error: unknown) {
        const errorMsg = (error as Error).message;

        const backoffMs = Math.min(60000, 5000 * Math.pow(2, job.attempts));
        await supabase
          .from('refresh_jobs')
          .update({
            status: job.attempts >= job.max_attempts ? 'dead' : 'failed',
            last_error: errorMsg,
            next_run_at: new Date(Date.now() + backoffMs).toISOString(),
            locked_at: null,
            locked_by: null,
          })
          .eq('id', job.id);

        results.push({ job_id: job.id, platform: job.platform, status: 'failed', error: errorMsg });
      }
    }

    return NextResponse.json({
      worker_id: workerId,
      jobs_processed: results.length,
      results,
    });
  } catch (error: unknown) {
    console.error('[cron/run-worker] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

async function upsertLeaderboardData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: ReturnType<typeof createClient<any>>,
  platform: Platform,
  market_type: MarketType,
  window: Window,
  entries: LeaderboardEntry[],
  provenance: Record<string, unknown>,
) {
  const now = new Date().toISOString();

  // Upsert sources
  const sources = entries.map(e => ({
    platform,
    market_type,
    trader_key: e.trader_key,
    display_name: e.display_name,
    profile_url: e.profile_url,
    last_seen_at: now,
    is_active: true,
    raw: e.raw,
  }));

  await supabase
    .from('trader_sources_v2')
    .upsert(sources, { onConflict: 'platform,market_type,trader_key' });

  // Insert snapshots
  const snapshots = entries
    .filter(e => e.metrics.roi_pct != null || Object.keys(e.metrics).length > 0)
    .map(e => {
      const roi = e.metrics.roi_pct ?? null;
      const arenaScore = roi != null
        ? calculateArenaScore(roi, e.metrics.pnl_usd ?? null, e.metrics.max_drawdown ?? null, e.metrics.win_rate ?? null, window)
        : null;

      return {
        platform,
        market_type,
        trader_key: e.trader_key,
        window,
        as_of_ts: now,
        metrics: e.metrics,
        roi_pct: roi,
        pnl_usd: e.metrics.pnl_usd ?? null,
        win_rate: e.metrics.win_rate ?? null,
        max_drawdown: e.metrics.max_drawdown ?? null,
        trades_count: e.metrics.trades_count ?? null,
        followers: e.metrics.followers ?? null,
        copiers: e.metrics.copiers ?? null,
        sharpe_ratio: e.metrics.sharpe_ratio ?? null,
        arena_score: arenaScore,
        quality_flags: { missing_roi: roi == null },
        provenance,
      };
    });

  // Insert in chunks
  for (let i = 0; i < snapshots.length; i += 50) {
    const chunk = snapshots.slice(i, i + 50);
    await supabase.from('trader_snapshots_v2').insert(chunk);
  }
}
