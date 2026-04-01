/**
 * RabbitX Perp Connector — DEAD (2026-04)
 *
 * Status: ALL DOMAINS DNS DEAD — platform shut down
 *
 * Investigation (2026-04-01):
 * - All RabbitX domains are DNS dead (NXDOMAIN / getaddrinfo ENOTFOUND):
 *   - rabbitx.io (main site)
 *   - rabbitx.com (alternate domain)
 *   - app.rabbitx.io (trading app)
 *   - docs.rabbitx.com (API documentation)
 *   - api.rabbitx.com (REST API)
 *   - api.prod.rabbitx.io (production REST API)
 *   - docs.blastfutures.com (related rebrand, also dead)
 * - The RBX token still trades on some exchanges (MEXC) but the platform is gone
 * - GitHub repos (rabbitx-io, rabbitx-docs) still exist but platform is offline
 * - No successor platform found
 *
 * Conclusion: Platform has completely shut down. All infrastructure offline.
 * Should remain permanently in DEAD_BLOCKED_PLATFORMS.
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

export class RabbitXPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'rabbitx'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'rabbitx',
    market_types: ['perp'],
    native_windows: [],
    available_fields: [],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 5,
    rate_limit: { rpm: 0, concurrency: 0 },
    notes: [
      'DEAD: All domains DNS dead — platform completely shut down (2026-04)',
      'rabbitx.io, rabbitx.com, app.rabbitx.io, api.rabbitx.com, api.prod.rabbitx.io — all NXDOMAIN',
      'docs.blastfutures.com (related rebrand) also dead',
      'RBX token still trades on MEXC but platform infrastructure is offline',
    ],
  }

  async discoverLeaderboard(
    _window: Window,
    _limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // DEAD: All RabbitX domains are DNS dead.
    // Platform has completely shut down — no API, no website, no docs.
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
