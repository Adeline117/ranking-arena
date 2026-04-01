/**
 * Vertex Protocol Perp Connector — DEAD (2026-04)
 *
 * Status: NO PUBLIC LEADERBOARD API
 *
 * Investigation (2026-04-01):
 * - leaderboard.vertexprotocol.com is a competition-specific React SPA
 * - Its backend (prod.vertexprotocol-backend.com) no longer resolves (DNS dead)
 * - The backend used POST /indexer with {leaderboard: {start, limit}} body
 *   Response fields: subaccount, pnl (wei/1e18), percent_pnl (wei/1e16), rank
 * - archive.prod.vertexprotocol.com resolves but TLS handshake fails
 * - Official Vertex SDK (Python/TS/Rust) has ZERO leaderboard endpoints
 * - Vertex indexer API only has per-subaccount queries, no ranking/aggregation
 * - The leaderboard was a one-off trading competition, not a permanent feature
 *
 * Conclusion: No public leaderboard API exists. The competition backend is dead.
 * Platform should remain in DEAD_BLOCKED_PLATFORMS and NO_ENRICHMENT_PLATFORMS.
 */

import { BaseConnector } from '../base'
import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  PlatformCapabilities,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
} from '../../types/leaderboard'

export class VertexPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'vertex'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'vertex',
    market_types: ['perp'],
    native_windows: [],
    available_fields: [],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 5,
    rate_limit: { rpm: 0, concurrency: 0 },
    notes: [
      'DEAD: No public leaderboard API — competition backend (prod.vertexprotocol-backend.com) DNS dead',
      'Official SDK has zero leaderboard/ranking endpoints',
      'Indexer only supports per-subaccount queries, no aggregation/ranking',
      'leaderboard.vertexprotocol.com was a one-off competition SPA, not permanent',
    ],
  }

  async discoverLeaderboard(
    _window: Window,
    _limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // DEAD: No public leaderboard API exists.
    // The competition backend (prod.vertexprotocol-backend.com) is DNS dead.
    // The official Vertex SDK/indexer has no leaderboard endpoints.
    return {
      traders: [],
      total_available: 0,
      window: _window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(_raw: unknown): Record<string, unknown> {
    return {
      trader_key: null,
      display_name: null,
      roi: null,
      pnl: null,
      platform_rank: null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: null,
    }
  }
}
