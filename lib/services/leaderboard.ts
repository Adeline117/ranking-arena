/**
 * Leaderboard Service: read-only data access for rankings and trader details.
 *
 * All methods read from pre-populated DB tables.
 * No synchronous scraping is ever triggered from these methods.
 *
 * Performance targets:
 * - Rankings query: <100ms (indexed snapshot table)
 * - Trader detail: <200ms (parallel queries)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  Platform,
  TradingCategory,
  RankingWindow,
  RankingsQuery,
  RankingsResponse,
  RankedTraderRow,
  TraderDetailResponse,
  TraderIdentity,
  TraderProfileEnriched,
  TraderSnapshot,
  TraderTimeseries,
  SnapshotMetrics,
  SnapshotQuality,
} from '@/lib/types/leaderboard';
import { PLATFORM_CATEGORY } from '@/lib/types/leaderboard';

// ============================================
// Constants
// ============================================

/** How old a snapshot can be before it's considered stale */
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Default page size */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ============================================
// Leaderboard Service
// ============================================

export class LeaderboardService {
  private supabase: SupabaseClient;

  constructor(supabaseUrl?: string, supabaseKey?: string) {
    this.supabase = createClient(
      supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL!,
      supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }

  // ============================================
  // Rankings
  // ============================================

  /**
   * Get ranked traders for a given window, with optional filters.
   * Reads from the latest snapshots in trader_snapshots_v2.
   */
  async getRankings(query: RankingsQuery): Promise<RankingsResponse> {
    const {
      window,
      category,
      platform,
      limit = DEFAULT_LIMIT,
      offset = 0,
      sort_by = 'arena_score',
      sort_dir = 'desc',
      min_pnl,
      min_trades,
    } = query;

    const safeLimit = Math.min(limit, MAX_LIMIT);

    // Build query against latest snapshots
    let dbQuery = this.supabase
      .from('trader_snapshots_v2')
      .select(
        `
        id,
        platform,
        trader_key,
        window,
        as_of_ts,
        metrics,
        quality,
        arena_score,
        roi_pct,
        pnl_usd,
        max_drawdown_pct,
        win_rate_pct,
        trades_count,
        copier_count,
        created_at
      `,
        { count: 'exact' },
      )
      .eq('window', window);

    // Platform filter
    if (platform) {
      dbQuery = dbQuery.eq('platform', platform);
    }

    // Category filter: map to list of platforms in that category
    if (category && !platform) {
      const platformsInCategory = Object.entries(PLATFORM_CATEGORY)
        .filter(([, cat]) => cat === category)
        .map(([p]) => p);
      dbQuery = dbQuery.in('platform', platformsInCategory);
    }

    // PnL filter
    if (min_pnl != null) {
      dbQuery = dbQuery.gte('pnl_usd', min_pnl);
    }

    // Trades filter
    if (min_trades != null) {
      dbQuery = dbQuery.gte('trades_count', min_trades);
    }

    // Sort
    const sortColumn = this.mapSortColumn(sort_by);
    dbQuery = dbQuery
      .order(sortColumn, { ascending: sort_dir === 'asc', nullsFirst: false })
      .range(offset, offset + safeLimit - 1);

    // We only want the latest snapshot per (platform, trader_key).
    // The view `latest_trader_snapshots` handles this, but for flexibility
    // we filter by recency: only snapshots from the last 24h.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    dbQuery = dbQuery.gte('as_of_ts', cutoff);

    const { data, count, error } = await dbQuery;

    if (error) {
      console.error('[LeaderboardService] Rankings query error:', error);
      throw new Error(`Rankings query failed: ${error.message}`);
    }

    // Deduplicate: keep only the first (best-ranked) snapshot per (platform, trader_key).
    // Since data is already sorted by the requested sort column, first occurrence wins.
    const seen = new Set<string>();
    const deduped = (data || []).filter((row) => {
      const key = `${row.platform}:${row.trader_key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Join with trader_sources_v2 for display names
    const displayNames = await this.getDisplayNames(deduped);

    // Build response
    const rankedRows: RankedTraderRow[] = deduped.map((row, idx) => ({
      rank: offset + idx + 1,
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      display_name: displayNames.get(`${row.platform}:${row.trader_key}`)?.display_name || null,
      avatar_url: displayNames.get(`${row.platform}:${row.trader_key}`)?.avatar_url || null,
      category: PLATFORM_CATEGORY[row.platform as Platform] || 'futures',
      metrics: row.metrics as SnapshotMetrics,
      quality: row.quality as SnapshotQuality,
      as_of_ts: row.as_of_ts,
    }));

    return {
      data: rankedRows,
      meta: {
        window,
        category: category || 'all',
        platform: platform || 'all',
        total_count: count || 0,
        limit: safeLimit,
        offset,
        cached_at: new Date().toISOString(),
        sort_by,
        sort_dir,
      },
    };
  }

  // ============================================
  // Trader Detail
  // ============================================

  /**
   * Get full trader detail (profile + snapshots + timeseries).
   * All data is read from DB. Target: <200ms.
   */
  async getTraderDetail(platform: Platform, traderKey: string): Promise<TraderDetailResponse> {
    // Run all queries in parallel for speed
    const [identity, profile, snapshots, timeseries] = await Promise.all([
      this.getTraderIdentity(platform, traderKey),
      this.getTraderProfile(platform, traderKey),
      this.getLatestSnapshots(platform, traderKey),
      this.getTraderTimeseries(platform, traderKey),
    ]);

    if (!identity) {
      throw new Error(`Trader not found: ${platform}/${traderKey}`);
    }

    // Determine data freshness
    const snapshotTimes = Object.values(snapshots)
      .filter(Boolean)
      .map((s) => new Date(s!.as_of_ts).getTime());
    const latestSnapshot = snapshotTimes.length > 0 ? Math.max(...snapshotTimes) : null;

    const isStale = latestSnapshot
      ? Date.now() - latestSnapshot > STALE_THRESHOLD_MS
      : true;

    return {
      identity,
      profile,
      snapshots,
      timeseries,
      data_freshness: {
        last_snapshot_at: latestSnapshot ? new Date(latestSnapshot).toISOString() : null,
        last_profile_at: profile?.last_enriched_at || null,
        last_timeseries_at: timeseries.length > 0 ? timeseries[0].as_of_ts : null,
        is_stale: isStale,
        stale_reason: isStale
          ? latestSnapshot
            ? 'Data is older than 4 hours'
            : 'No snapshot data available'
          : null,
      },
    };
  }

  // ============================================
  // Private: Data Access
  // ============================================

  private async getTraderIdentity(
    platform: Platform,
    traderKey: string,
  ): Promise<TraderIdentity | null> {
    const { data } = await this.supabase
      .from('trader_sources_v2')
      .select('*')
      .eq('platform', platform)
      .eq('trader_key', traderKey)
      .single();

    if (!data) return null;

    return {
      platform: data.platform as Platform,
      trader_key: data.trader_key,
      display_name: data.display_name,
      avatar_url: data.avatar_url,
      profile_url: data.profile_url,
      discovered_at: data.discovered_at,
      last_seen: data.last_seen,
    };
  }

  private async getTraderProfile(
    platform: Platform,
    traderKey: string,
  ): Promise<TraderProfileEnriched | null> {
    const { data } = await this.supabase
      .from('trader_profiles_v2')
      .select('*')
      .eq('platform', platform)
      .eq('trader_key', traderKey)
      .single();

    if (!data) return null;

    return {
      platform: data.platform as Platform,
      trader_key: data.trader_key,
      display_name: data.display_name,
      avatar_url: data.avatar_url,
      bio: data.bio,
      copier_count: data.copier_count,
      aum_usd: data.aum_usd ? Number(data.aum_usd) : null,
      active_since: data.active_since,
      platform_tier: data.platform_tier,
      last_enriched_at: data.last_enriched_at,
    };
  }

  private async getLatestSnapshots(
    platform: Platform,
    traderKey: string,
  ): Promise<Record<RankingWindow, TraderSnapshot | null>> {
    const { data } = await this.supabase
      .from('trader_snapshots_v2')
      .select('*')
      .eq('platform', platform)
      .eq('trader_key', traderKey)
      .in('window', ['7d', '30d', '90d'])
      .order('as_of_ts', { ascending: false })
      .limit(3);

    const result: Record<RankingWindow, TraderSnapshot | null> = {
      '7d': null,
      '30d': null,
      '90d': null,
    };

    if (data) {
      // Get the latest snapshot for each window
      const seen = new Set<string>();
      for (const row of data) {
        if (!seen.has(row.window)) {
          seen.add(row.window);
          result[row.window as RankingWindow] = {
            id: row.id,
            platform: row.platform as Platform,
            trader_key: row.trader_key,
            window: row.window as RankingWindow,
            as_of_ts: row.as_of_ts,
            metrics: row.metrics as SnapshotMetrics,
            quality: row.quality as SnapshotQuality,
            created_at: row.created_at,
          };
        }
      }
    }

    return result;
  }

  private async getTraderTimeseries(
    platform: Platform,
    traderKey: string,
  ): Promise<TraderTimeseries[]> {
    const { data } = await this.supabase
      .from('trader_timeseries_v2')
      .select('*')
      .eq('platform', platform)
      .eq('trader_key', traderKey)
      .order('as_of_ts', { ascending: false })
      .limit(10); // Latest 10 series entries

    if (!data) return [];

    return data.map((row) => ({
      id: row.id,
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      series_type: row.series_type,
      data: row.data,
      as_of_ts: row.as_of_ts,
      created_at: row.created_at,
    }));
  }

  private async getDisplayNames(
    snapshots: Array<{ platform: string; trader_key: string }>,
  ): Promise<Map<string, { display_name: string | null; avatar_url: string | null }>> {
    const result = new Map<string, { display_name: string | null; avatar_url: string | null }>();

    if (snapshots.length === 0) return result;

    // Batch query trader_sources_v2 for display names
    const keys = [...new Set(snapshots.map((s) => s.trader_key))];

    const { data } = await this.supabase
      .from('trader_sources_v2')
      .select('platform, trader_key, display_name, avatar_url')
      .in('trader_key', keys);

    if (data) {
      for (const row of data) {
        result.set(`${row.platform}:${row.trader_key}`, {
          display_name: row.display_name,
          avatar_url: row.avatar_url,
        });
      }
    }

    return result;
  }

  // ============================================
  // Private: Helpers
  // ============================================

  private mapSortColumn(sortBy: string): string {
    switch (sortBy) {
      case 'arena_score':
        return 'arena_score';
      case 'roi':
        return 'roi_pct';
      case 'pnl':
        return 'pnl_usd';
      case 'drawdown':
        return 'max_drawdown_pct';
      case 'copiers':
        return 'copier_count';
      default:
        return 'arena_score';
    }
  }
}
