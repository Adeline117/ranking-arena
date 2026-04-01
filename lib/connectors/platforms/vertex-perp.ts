/**
 * Vertex Protocol Perp Connector
 *
 * Vertex is a DEX on Arbitrum offering spot + perp trading.
 * Leaderboard: https://leaderboard.vertexprotocol.com/
 *
 * TODO: The leaderboard site at leaderboard.vertexprotocol.com likely fetches
 * from an internal API. Inspect network requests to discover the actual endpoint.
 * Current placeholder uses the archive indexer API which provides subaccount data.
 *
 * Archive API docs: https://vertex-protocol.gitbook.io/docs/developer-resources/api/archive-indexer
 * Gateway API: https://gateway.prod.vertexprotocol.com/v1
 * Indexer API: https://archive.prod.vertexprotocol.com/v1
 */

import { BaseConnector } from '../base'
import { safeNumber } from '../utils'
import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  PlatformCapabilities,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
} from '../../types/leaderboard'

// TODO: Discover actual response shape from leaderboard.vertexprotocol.com network requests
interface VertexLeaderboardEntry {
  subaccount: string       // hex subaccount ID (includes wallet address)
  pnl: number | string
  roi: number | string     // ROI as decimal or percentage
  volume: number | string
  rank?: number
  display_name?: string
}

interface VertexLeaderboardResponse {
  leaderboard?: VertexLeaderboardEntry[]
  traders?: VertexLeaderboardEntry[]
  data?: VertexLeaderboardEntry[]
}

export class VertexPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'vertex'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'vertex',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'DEX on Arbitrum — no copy trading',
      'trader_key is subaccount hex (includes wallet address)',
      'TODO: Discover actual leaderboard API endpoint from leaderboard.vertexprotocol.com',
    ],
  }

  // TODO: Map windows to actual Vertex API parameters once endpoint is discovered
  private mapWindowToParam(window: Window): string {
    const m: Record<Window, string> = {
      '7d': 'weekly',
      '30d': 'monthly',
      '90d': 'all_time',
    }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // TODO: Replace with actual leaderboard API endpoint once discovered.
    // The leaderboard site at leaderboard.vertexprotocol.com fetches data from
    // an internal API — inspect network requests to find it.
    // Possible endpoints:
    //   - https://leaderboard.vertexprotocol.com/api/leaderboard
    //   - https://archive.prod.vertexprotocol.com/v1 (indexer)
    //   - https://gateway.prod.vertexprotocol.com/v1 (gateway)
    const period = this.mapWindowToParam(window)
    const data = await this.request<VertexLeaderboardResponse>(
      `https://leaderboard.vertexprotocol.com/api/leaderboard?period=${period}&limit=${limit}`
    )

    const entries = data?.leaderboard || data?.traders || data?.data || []

    const traders: TraderSource[] = entries.slice(0, limit).map((entry: VertexLeaderboardEntry, idx: number) => {
      const traderKey = (entry.subaccount || '').toLowerCase()
      // Extract wallet address from subaccount (first 42 chars of hex = 0x + 40)
      const walletAddress = traderKey.length >= 42 ? traderKey.slice(0, 42) : traderKey

      return {
        platform: this.platform,
        market_type: this.marketType,
        trader_key: traderKey,
        display_name: entry.display_name || null,
        profile_url: `https://app.vertexprotocol.com/portfolio/${walletAddress}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: {
          ...entry as unknown as Record<string, unknown>,
          _window: period,
          _rank: entry.rank ?? idx + 1,
        },
      }
    })

    return {
      traders,
      total_available: entries.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    // Vertex is a DEX — no user profiles, only wallet addresses
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // TODO: Implement using Vertex indexer API for subaccount stats
    // https://archive.prod.vertexprotocol.com/v1 — subaccount historical data
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Vertex leaderboard entry.
   * ROI may be decimal (0.35 = 35%) or percentage — apply smart detection.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as VertexLeaderboardEntry
    const rawRoi = safeNumber(e.roi)
    const pnl = safeNumber(e.pnl)

    // Smart ROI detection: if |roi| <= 10, treat as decimal and convert to percentage
    const roi = rawRoi != null
      ? (Math.abs(rawRoi) <= 10 ? rawRoi * 100 : rawRoi)
      : null

    return {
      trader_key: (e.subaccount || '').toLowerCase(),
      display_name: e.display_name || null,
      avatar_url: null,
      roi,
      pnl,
      platform_rank: e.rank ?? null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      copiers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
    }
  }
}
