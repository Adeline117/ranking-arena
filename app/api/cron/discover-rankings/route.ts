/**
 * Cron endpoint: Trigger discovery jobs for all platforms
 *
 * This is called by Vercel Cron to schedule background discovery/snapshot jobs.
 * It does NOT do scraping directly - it only seeds the job queue.
 *
 * Schedule: Every 4 hours (see vercel.json)
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// All ranking-capable platform/market_type combinations
const RANKING_PLATFORMS = [
  { platform: 'binance', market_type: 'futures', priority: 5 },
  { platform: 'binance', market_type: 'spot', priority: 10 },
  { platform: 'binance', market_type: 'web3', priority: 20 },
  { platform: 'bybit', market_type: 'futures', priority: 5 },
  { platform: 'bitget', market_type: 'futures', priority: 10 },
  { platform: 'bitget', market_type: 'spot', priority: 15 },
  { platform: 'mexc', market_type: 'futures', priority: 15 },
  { platform: 'coinex', market_type: 'futures', priority: 20 },
  { platform: 'okx', market_type: 'futures', priority: 10 },
  { platform: 'okx_wallet', market_type: 'web3', priority: 25 },
  { platform: 'kucoin', market_type: 'futures', priority: 15 },
  { platform: 'bitmart', market_type: 'futures', priority: 25 },
  { platform: 'phemex', market_type: 'futures', priority: 20 },
  { platform: 'htx', market_type: 'futures', priority: 25 },
  { platform: 'weex', market_type: 'futures', priority: 25 },
  { platform: 'gmx', market_type: 'perp', priority: 15 },
  { platform: 'dydx', market_type: 'perp', priority: 15 },
  { platform: 'hyperliquid', market_type: 'perp', priority: 15 },
  // Dune on-chain leaderboards (lower priority due to rate limits)
  { platform: 'dune_gmx', market_type: 'perp', priority: 20 },
  { platform: 'dune_hyperliquid', market_type: 'perp', priority: 20 },
  { platform: 'dune_uniswap', market_type: 'spot', priority: 20 },
  { platform: 'dune_defi', market_type: 'web3', priority: 25 },
];

export async function GET(request: Request) {
  // Verify cron secret if configured
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (!SUPABASE_KEY) {
      return NextResponse.json({ error: 'Service not configured' }, { status: 500 });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Check which platforms have healthy status (not circuit-open)
    const { data: healthData } = await supabase
      .from('platform_health')
      .select('platform, status');

    const blockedPlatforms = new Set(
      (healthData || [])
        .filter(h => h.status === 'circuit_open')
        .map(h => h.platform)
    );

    // Create discovery jobs for all non-blocked platforms
    const jobs = RANKING_PLATFORMS
      .filter(p => !blockedPlatforms.has(p.platform))
      .map(p => ({
        job_type: 'DISCOVER',
        platform: p.platform,
        market_type: p.market_type,
        priority: p.priority,
        status: 'pending',
        next_run_at: new Date().toISOString(),
      }));

    if (jobs.length === 0) {
      return NextResponse.json({
        message: 'All platforms are circuit-open, no jobs created',
        blocked: Array.from(blockedPlatforms),
      });
    }

    // Upsert jobs (avoid duplicates for same platform+market_type+DISCOVER that are pending)
    const { error } = await supabase
      .from('refresh_jobs')
      .insert(jobs);

    if (error) {
      console.error('[cron/discover] Job insert error:', error.message);
    }

    // Also release any stale locks
    await supabase.rpc('release_stale_locks');

    return NextResponse.json({
      message: `Created ${jobs.length} discovery jobs`,
      blocked: Array.from(blockedPlatforms),
      platforms: jobs.map(j => `${j.platform}:${j.market_type}`),
    });
  } catch (error) {
    console.error('[cron/discover] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
