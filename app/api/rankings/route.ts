// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck - Supabase tables not in generated types (v2 schema)
/**
 * GET /api/rankings
 *
 * Returns ranked traders from the snapshots table.
 * Reads ONLY from DB (no sync fetching).
 * Supports filtering by window, platform, market_type, and sort.
 *
 * Query params:
 *   - window: '7d' | '30d' | '90d' (default: '90d')
 *   - platform: platform name or 'all' (default: 'all')
 *   - market_type: 'futures' | 'spot' | 'web3' | 'perp' | 'all' (default: 'all')
 *   - sort: 'roi_desc' | 'arena_score' | 'pnl_desc' (default: 'roi_desc')
 *   - limit: number (default: 100, max: 500)
 *   - offset: number (default: 0)
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Data freshness: only show snapshots from last 24 hours
const FRESHNESS_HOURS = 24;

type SortField = 'roi_desc' | 'arena_score' | 'pnl_desc';

export async function GET(request: Request) {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const window = url.searchParams.get('window') || '90d';
    const platform = url.searchParams.get('platform') || 'all';
    const market_type = url.searchParams.get('market_type') || 'all';
    const sort = (url.searchParams.get('sort') || 'roi_desc') as SortField;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    // Validate window
    if (!['7d', '30d', '90d'].includes(window)) {
      return NextResponse.json(
        { error: 'Invalid window. Must be 7d, 30d, or 90d' },
        { status: 400 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Build query
    const freshnessThreshold = new Date(Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('trader_snapshots_v2')
      .select(`
        platform,
        market_type,
        trader_key,
        window,
        roi_pct,
        pnl_usd,
        win_rate,
        max_drawdown,
        trades_count,
        followers,
        copiers,
        arena_score,
        quality_flags,
        provenance,
        as_of_ts,
        updated_at
      `)
      .eq('window', window)
      .gte('as_of_ts', freshnessThreshold);

    // Platform filter
    if (platform !== 'all') {
      query = query.eq('platform', platform);
    }

    // Market type filter
    if (market_type !== 'all') {
      query = query.eq('market_type', market_type);
    }

    // Sort order
    switch (sort) {
      case 'roi_desc':
        query = query
          .not('roi_pct', 'is', null)
          .order('roi_pct', { ascending: false, nullsFirst: false });
        break;
      case 'arena_score':
        query = query
          .order('arena_score', { ascending: false, nullsFirst: false });
        break;
      case 'pnl_desc':
        query = query
          .order('pnl_usd', { ascending: false, nullsFirst: false });
        break;
    }

    // Pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      console.error('[rankings] Query error:', error.message);
      return NextResponse.json(
        { error: 'Failed to fetch rankings', details: error.message },
        { status: 500 }
      );
    }

    // Deduplicate: keep latest snapshot per trader per platform
    const deduped = deduplicateSnapshots(data || []);

    // Enrich with profile data (display names, avatars)
    const traderKeys = deduped.map(s => ({
      platform: s.platform,
      market_type: s.market_type,
      trader_key: s.trader_key,
    }));

    const profiles = await fetchProfiles(supabase, traderKeys);

    // Build response
    const now = new Date().toISOString();
    const rankingEntries = deduped.map((snapshot, idx) => {
      const profileKey = `${snapshot.platform}:${snapshot.market_type}:${snapshot.trader_key}`;
      const profile = profiles.get(profileKey);
      const updatedAt = snapshot.updated_at || snapshot.as_of_ts;
      const ageMs = Date.now() - new Date(updatedAt).getTime();
      const isStale = ageMs > FRESHNESS_HOURS * 60 * 60 * 1000;

      return {
        rank: offset + idx + 1,
        platform: snapshot.platform,
        market_type: snapshot.market_type,
        trader_key: snapshot.trader_key,
        display_name: profile?.display_name || null,
        avatar_url: profile?.avatar_url || null,
        profile_url: profile?.profile_url || null,
        roi_pct: snapshot.roi_pct,
        pnl_usd: snapshot.pnl_usd,
        win_rate: snapshot.win_rate,
        max_drawdown: snapshot.max_drawdown,
        trades_count: snapshot.trades_count,
        followers: snapshot.followers,
        arena_score: snapshot.arena_score,
        updated_at: updatedAt,
        staleness: isStale,
        quality_flags: snapshot.quality_flags || {},
        provenance: snapshot.provenance || {},
      };
    });

    const elapsed = Date.now() - startTime;

    return NextResponse.json({
      data: rankingEntries,
      meta: {
        total: rankingEntries.length,
        window,
        platform,
        market_type,
        sort,
        updated_at: now,
        staleness: rankingEntries.some(e => e.staleness),
        query_ms: elapsed,
      },
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        'X-Response-Time': `${elapsed}ms`,
      },
    });
  } catch (error) {
    console.error('[rankings] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ============================================
// Helpers
// ============================================

interface SnapshotRow {
  platform: string;
  market_type: string;
  trader_key: string;
  window: string;
  roi_pct: number | null;
  pnl_usd: number | null;
  win_rate: number | null;
  max_drawdown: number | null;
  trades_count: number | null;
  followers: number | null;
  copiers: number | null;
  arena_score: number | null;
  quality_flags: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  as_of_ts: string;
  updated_at: string;
}

function deduplicateSnapshots(snapshots: SnapshotRow[]): SnapshotRow[] {
  const seen = new Map<string, SnapshotRow>();

  for (const s of snapshots) {
    const key = `${s.platform}:${s.market_type}:${s.trader_key}`;
    const existing = seen.get(key);

    if (!existing || new Date(s.as_of_ts) > new Date(existing.as_of_ts)) {
      seen.set(key, s);
    }
  }

  return Array.from(seen.values());
}

async function fetchProfiles(
  supabase: ReturnType<typeof createClient>,
  keys: Array<{ platform: string; market_type: string; trader_key: string }>
): Promise<Map<string, { display_name: string | null; avatar_url: string | null; profile_url: string | null }>> {
  const profiles = new Map<string, { display_name: string | null; avatar_url: string | null; profile_url: string | null }>();

  if (keys.length === 0) return profiles;

  // Batch fetch profiles
  const traderKeys = keys.map(k => k.trader_key);
  const { data } = await supabase
    .from('trader_profiles_v2')
    .select('platform, market_type, trader_key, display_name, avatar_url, profile_url')
    .in('trader_key', traderKeys.slice(0, 100));

  if (data) {
    for (const p of data) {
      const key = `${p.platform}:${p.market_type}:${p.trader_key}`;
      profiles.set(key, {
        display_name: p.display_name,
        avatar_url: p.avatar_url,
        profile_url: p.profile_url,
      });
    }
  }

  // Also check trader_sources_v2 for display names
  const { data: sources } = await supabase
    .from('trader_sources_v2')
    .select('platform, market_type, trader_key, display_name, profile_url')
    .in('trader_key', traderKeys.slice(0, 100));

  if (sources) {
    for (const s of sources) {
      const key = `${s.platform}:${s.market_type}:${s.trader_key}`;
      if (!profiles.has(key) && s.display_name) {
        profiles.set(key, {
          display_name: s.display_name,
          avatar_url: null,
          profile_url: s.profile_url,
        });
      }
    }
  }

  return profiles;
}
