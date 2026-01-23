// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - Supabase tables not in generated types (v2 schema)
/**
 * GET /api/trader/:platform/:market_type/:trader_key
 *
 * Returns trader profile + all window snapshots.
 * Reads ONLY from DB.
 *
 * Response includes:
 *   - profile: Trader profile data
 *   - snapshots: { '7d': ..., '30d': ..., '90d': ... }
 *   - updated_at: Last data refresh time
 *   - staleness: Whether data is stale
 *   - provenance: Data source info
 *   - quality_flags: Missing fields info
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const FRESHNESS_HOURS = 24;

interface RouteParams {
  params: Promise<{
    platform: string;
    market_type: string;
    trader_key: string;
  }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  const startTime = Date.now();
  const { platform, market_type, trader_key } = await params;

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Fetch profile
    const { data: profile } = await supabase
      .from('trader_profiles_v2')
      .select('*')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key)
      .single();

    // Fetch latest snapshots for each window
    const { data: snapshots } = await supabase
      .from('trader_snapshots_v2')
      .select('*')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key)
      .order('as_of_ts', { ascending: false })
      .limit(10);

    // Also check trader_sources_v2 for basic info if no profile
    let sourceInfo = null;
    if (!profile) {
      const { data: source } = await supabase
        .from('trader_sources_v2')
        .select('*')
        .eq('platform', platform)
        .eq('market_type', market_type)
        .eq('trader_key', trader_key)
        .single();
      sourceInfo = source;
    }

    // Group snapshots by window (latest per window)
    const snapshotsByWindow: Record<string, typeof snapshots extends Array<infer T> ? T : never> = {};
    if (snapshots) {
      for (const s of snapshots) {
        if (!snapshotsByWindow[s.window]) {
          snapshotsByWindow[s.window] = s;
        }
      }
    }

    // Determine staleness
    const latestUpdate = snapshots?.[0]?.as_of_ts || profile?.updated_at;
    const isStale = latestUpdate
      ? Date.now() - new Date(latestUpdate).getTime() > FRESHNESS_HOURS * 60 * 60 * 1000
      : true;

    // Aggregate quality flags
    const allFlags: Record<string, unknown> = {};
    for (const s of snapshots || []) {
      if (s.quality_flags) Object.assign(allFlags, s.quality_flags);
    }

    const elapsed = Date.now() - startTime;

    // Build profile response
    const profileData = profile || (sourceInfo ? {
      platform: sourceInfo.platform,
      market_type: sourceInfo.market_type,
      trader_key: sourceInfo.trader_key,
      display_name: sourceInfo.display_name,
      avatar_url: null,
      bio: null,
      tags: [],
      profile_url: sourceInfo.profile_url,
      followers: null,
      copiers: null,
      aum: null,
    } : {
      platform,
      market_type,
      trader_key,
      display_name: null,
      avatar_url: null,
      bio: null,
      tags: [],
      profile_url: null,
      followers: null,
      copiers: null,
      aum: null,
    });

    return NextResponse.json({
      profile: profileData,
      snapshots: {
        '7d': snapshotsByWindow['7d'] || null,
        '30d': snapshotsByWindow['30d'] || null,
        '90d': snapshotsByWindow['90d'] || null,
      },
      updated_at: latestUpdate || null,
      staleness: isStale,
      provenance: snapshots?.[0]?.provenance || {},
      quality_flags: allFlags,
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'X-Response-Time': `${elapsed}ms`,
      },
    });
  } catch (error) {
    console.error('[trader] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
