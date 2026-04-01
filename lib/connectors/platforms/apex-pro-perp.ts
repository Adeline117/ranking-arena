/**
 * ApeX Pro (Apex Omni) Perp Connector — DEAD (2026-04)
 *
 * Status: NO PUBLIC LEADERBOARD API
 *
 * Investigation (2026-04-01):
 * - omni.apex.exchange/leaderboard exists as a client-side page
 * - Official API docs (api-docs.pro.apex.exchange) only expose:
 *   trading, account, market data, WebSocket endpoints
 * - ZERO leaderboard/ranking/vault-list/copy-trading endpoints documented
 * - Tested endpoints (all 404):
 *   - omni.apex.exchange/api/v3/leaderboard
 *   - omni.apex.exchange/api/v3/vaults
 *   - omni.apex.exchange/api/v3/vault/list
 *   - omni.apex.exchange/api/v3/vault/rankings
 *   - omni.apex.exchange/api/v3/competition/ranking
 *   - omni.apex.exchange/api/v3/copy-trading/leaderboard
 *   - omni.apex.exchange/api/v3/ranking
 *   - omni.apex.exchange/api/v3/competition
 * - Python SDK (apexpro-openapi) only has trading/account methods
 * - The leaderboard page loads data via client-side JS with no discoverable
 *   public API endpoint (likely uses authenticated internal API or GraphQL)
 *
 * Conclusion: No public leaderboard API. The leaderboard data is only
 * accessible through the web UI with no documented API endpoints.
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

export class ApexProPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'apex_pro'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'apex_pro',
    market_types: ['perp'],
    native_windows: [],
    available_fields: [],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 5,
    rate_limit: { rpm: 0, concurrency: 0 },
    notes: [
      'DEAD: No public leaderboard API — tested 8+ endpoint patterns, all 404',
      'Official API docs only cover trading/account/market endpoints',
      'Leaderboard page uses internal/authenticated API not publicly accessible',
      'Vault/copy-trading features exist on web UI but no public API',
    ],
  }

  async discoverLeaderboard(
    _window: Window,
    _limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // DEAD: No public leaderboard API exists.
    // Tested 8+ API endpoint patterns — all return 404.
    // Official API docs have zero leaderboard/ranking endpoints.
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
