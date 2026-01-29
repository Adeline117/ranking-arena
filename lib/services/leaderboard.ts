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

import { query, queryOne } from '@/lib/db';
import type {
  Platform,
  GranularPlatform,
  TradingCategory,
  RankingWindow,
  RankingsQuery,
  RankedTraderRow,
  TraderIdentity,
  TraderProfileEnriched,
  TraderSnapshotLegacy,
  TraderTimeseriesLegacy,
  SnapshotMetrics,
  SnapshotMetricsLegacy,
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

/** Legacy rankings response format used by this service */
interface LegacyRankingsResponse {
  data: RankedTraderRow[];
  meta: {
    window: RankingWindow;
    category: TradingCategory | 'all';
    platform: Platform | 'all';
    total_count: number;
    limit: number;
    offset: number;
    cached_at: string;
    sort_by?: string;
    sort_dir?: string;
  };
}

/** Legacy trader detail response format used by this service */
interface LegacyTraderDetailResponse {
  identity: TraderIdentity;
  profile: TraderProfileEnriched | null;
  snapshots: Record<RankingWindow, TraderSnapshotLegacy | null>;
  timeseries: TraderTimeseriesLegacy[];
  data_freshness: {
    last_snapshot_at: string | null;
    last_profile_at: string | null;
    last_timeseries_at: string | null;
    is_stale: boolean;
    stale_reason: string | null;
  };
}

// ============================================
// Leaderboard Service
// ============================================

export class LeaderboardService {
  // ============================================
  // Rankings
  // ============================================

  /**
   * Get ranked traders for a given window, with optional filters.
   * Reads from the latest snapshots in trader_snapshots_v2.
   */
  async getRankings(rankingsQuery: RankingsQuery): Promise<LegacyRankingsResponse> {
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
    } = rankingsQuery;

    const safeLimit = Math.min(limit, MAX_LIMIT);
    const sortColumn = this.mapSortColumn(sort_by);
    const sortDirection = sort_dir === 'asc' ? 'ASC' : 'DESC';

    // Build WHERE conditions
    const conditions: string[] = [`s."window" = $1`];
    const params: unknown[] = [window];
    let paramIdx = 2;

    // Only snapshots from last 24h for freshness
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    conditions.push(`s.as_of_ts >= $${paramIdx}`);
    params.push(cutoff);
    paramIdx++;

    // Platform filter
    if (platform) {
      conditions.push(`s.platform = $${paramIdx}`);
      params.push(platform);
      paramIdx++;
    }

    // Category filter
    if (category && !platform) {
      const platformsInCategory = Object.entries(PLATFORM_CATEGORY)
        .filter(([, cat]) => cat === category)
        .map(([p]) => p);
      if (platformsInCategory.length > 0) {
        conditions.push(`s.platform = ANY($${paramIdx})`);
        params.push(platformsInCategory);
        paramIdx++;
      }
    }

    // PnL filter
    if (min_pnl != null) {
      conditions.push(`s.pnl_usd >= $${paramIdx}`);
      params.push(min_pnl);
      paramIdx++;
    }

    // Trades filter
    if (min_trades != null) {
      conditions.push(`s.trades_count >= $${paramIdx}`);
      params.push(min_trades);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    // Count query
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM trader_snapshots_v2 s WHERE ${whereClause}`,
      params,
    );
    const totalCount = parseInt(countResult.rows[0]?.count || '0', 10);

    // Data query with JOIN for display names
    const dataResult = await query<{
      id: string;
      platform: string;
      trader_key: string;
      window: string;
      as_of_ts: string;
      metrics: SnapshotMetrics;
      quality: SnapshotQuality;
      arena_score: string;
      roi_pct: string;
      pnl_usd: string;
      max_drawdown_pct: string;
      win_rate_pct: string;
      trades_count: number;
      copier_count: number;
      display_name: string | null;
      avatar_url: string | null;
    }>(
      `SELECT s.id, s.platform, s.trader_key, s."window", s.as_of_ts,
              s.metrics, s.quality, s.arena_score, s.roi_pct, s.pnl_usd,
              s.max_drawdown_pct, s.win_rate_pct, s.trades_count, s.copier_count,
              src.display_name, src.avatar_url
       FROM trader_snapshots_v2 s
       LEFT JOIN trader_sources_v2 src ON src.platform = s.platform AND src.trader_key = s.trader_key
       WHERE ${whereClause}
       ORDER BY s.${sortColumn} ${sortDirection} NULLS LAST
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, safeLimit, offset],
    );

    // Deduplicate: keep only the first (best-ranked) snapshot per (platform, trader_key).
    // Since data is already sorted by the requested sort column, first occurrence wins.
    const seen = new Set<string>();
    const deduped = dataResult.rows.filter((row) => {
      const key = `${row.platform}:${row.trader_key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const rankedRows: RankedTraderRow[] = deduped.map((row, idx) => ({
      rank: offset + idx + 1,
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      display_name: row.display_name || null,
      avatar_url: row.avatar_url || null,
      category: PLATFORM_CATEGORY[row.platform as unknown as GranularPlatform] || 'futures',
      metrics: row.metrics,
      quality: row.quality,
      as_of_ts: row.as_of_ts,
    }));

    return {
      data: rankedRows,
      meta: {
        window,
        category: category || 'all',
        platform: platform || 'all',
        total_count: totalCount,
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
  async getTraderDetail(platform: Platform, traderKey: string): Promise<LegacyTraderDetailResponse> {
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
    const row = await queryOne<{
      platform: string;
      trader_key: string;
      display_name: string | null;
      avatar_url: string | null;
      profile_url: string | null;
      discovered_at: string;
      last_seen: string;
    }>(
      `SELECT platform, trader_key, display_name, avatar_url, profile_url, discovered_at, last_seen
       FROM trader_sources_v2
       WHERE platform = $1 AND trader_key = $2`,
      [platform, traderKey],
    );

    if (!row) return null;

    return {
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      profile_url: row.profile_url,
      discovered_at: row.discovered_at,
      last_seen: row.last_seen,
    };
  }

  private async getTraderProfile(
    platform: Platform,
    traderKey: string,
  ): Promise<TraderProfileEnriched | null> {
    const row = await queryOne<{
      platform: string;
      trader_key: string;
      display_name: string | null;
      avatar_url: string | null;
      bio: string | null;
      copier_count: number | null;
      aum_usd: string | null;
      active_since: string | null;
      platform_tier: string | null;
      last_enriched_at: string | null;
    }>(
      `SELECT platform, trader_key, display_name, avatar_url, bio,
              copier_count, aum_usd, active_since, platform_tier, last_enriched_at
       FROM trader_profiles_v2
       WHERE platform = $1 AND trader_key = $2`,
      [platform, traderKey],
    );

    if (!row) return null;

    return {
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      bio: row.bio,
      copier_count: row.copier_count,
      aum_usd: row.aum_usd ? Number(row.aum_usd) : null,
      active_since: row.active_since,
      platform_tier: row.platform_tier,
      last_enriched_at: row.last_enriched_at || new Date().toISOString(),
    };
  }

  private async getLatestSnapshots(
    platform: Platform,
    traderKey: string,
  ): Promise<Record<RankingWindow, TraderSnapshotLegacy | null>> {
    const { rows } = await query<{
      id: string;
      platform: string;
      trader_key: string;
      window: string;
      as_of_ts: string;
      metrics: Record<string, unknown>;
      quality: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT id, platform, trader_key, "window", as_of_ts, metrics, quality, created_at
       FROM trader_snapshots_v2
       WHERE platform = $1 AND trader_key = $2 AND "window" = ANY($3)
       ORDER BY as_of_ts DESC
       LIMIT 3`,
      [platform, traderKey, ['7d', '30d', '90d']],
    );

    const result: Record<RankingWindow, TraderSnapshotLegacy | null> = {
      '7d': null,
      '30d': null,
      '90d': null,
    };

    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.window)) {
        seen.add(row.window);
        result[row.window as RankingWindow] = {
          id: row.id,
          platform: row.platform as Platform,
          trader_key: row.trader_key,
          window: row.window as RankingWindow,
          as_of_ts: row.as_of_ts,
          metrics: row.metrics as unknown as SnapshotMetricsLegacy,
          quality: row.quality as unknown as SnapshotQuality,
          created_at: row.created_at,
        };
      }
    }

    return result;
  }

  private async getTraderTimeseries(
    platform: Platform,
    traderKey: string,
  ): Promise<TraderTimeseriesLegacy[]> {
    const { rows } = await query<{
      id: string;
      platform: string;
      trader_key: string;
      series_type: string;
      data: unknown;
      as_of_ts: string;
      created_at: string;
    }>(
      `SELECT id, platform, trader_key, series_type, data, as_of_ts, created_at
       FROM trader_timeseries
       WHERE platform = $1 AND trader_key = $2
       ORDER BY as_of_ts DESC
       LIMIT 10`,
      [platform, traderKey],
    );

    return rows.map((row) => ({
      id: row.id,
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      series_type: row.series_type as TraderTimeseriesLegacy['series_type'],
      data: row.data as TraderTimeseriesLegacy['data'],
      as_of_ts: row.as_of_ts,
      created_at: row.created_at,
    }));
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
