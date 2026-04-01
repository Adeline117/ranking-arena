/**
 * Vertex Protocol Perp Connector
 *
 * Vertex is a DEX on Arbitrum offering spot, perp, and money markets.
 * Leaderboard: leaderboard.vertexprotocol.com
 *
 * TODO: The leaderboard API endpoint needs to be discovered by inspecting
 * network requests on leaderboard.vertexprotocol.com. The Vertex indexer
 * (archive.vertexprotocol.com) provides historical data per-subaccount
 * but there is no documented public leaderboard API endpoint yet.
 *
 * Current approach:
 * - Uses the Vertex indexer API to query subaccount summaries
 * - Leaderboard discovery uses the leaderboard.vertexprotocol.com backend
 * - trader_key is a hex subaccount address (bytes32)
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

interface VertexLeaderboardEntry {
  subaccount: string
  pnl: number | string
  roi: number | string
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
      'DEX on Arbitrum — no copy trading features',
      'trader_key is a bytes32 subaccount address',
      'TODO: Leaderboard API endpoint needs to be confirmed via network inspection',
    ],
  }

  private mapWindowToParam(window: Window): string {
    const m: Record<Window, string> = {
      '7d': 'week',
      '30d': 'month',
      '90d': 'all',
    }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // TODO: Replace with actual API endpoint once discovered.
    // The leaderboard.vertexprotocol.com frontend likely calls a backend API.
    // Candidate endpoints to try:
    //   - https://leaderboard.vertexprotocol.com/api/leaderboard?period=week&limit=500
    //   - https://archive.vertexprotocol.com/v2/leaderboard?window=week
    const period = this.mapWindowToParam(window)
    const data = await this.request<VertexLeaderboardResponse>(
      `https://leaderboard.vertexprotocol.com/api/leaderboard?period=${period}&limit=${limit}`
    )

    const entries = data?.leaderboard || data?.traders || data?.data || []

    const traders: TraderSource[] = entries.slice(0, limit).map((entry, idx) => {
      const subaccount = String(entry.subaccount || '')
      // Vertex subaccount addresses are bytes32 hex strings
      const shortAddr = subaccount.length > 10
        ? `${subaccount.slice(0, 6)}...${subaccount.slice(-4)}`
        : subaccount

      return {
        platform: this.platform,
        market_type: this.marketType,
        trader_key: subaccount.toLowerCase(),
        display_name: entry.display_name || shortAddr || null,
        profile_url: `https://app.vertexprotocol.com/portfolio/${subaccount}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: {
          ...entry as unknown as Record<string, unknown>,
          _window: window,
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
    // Vertex is a DEX — no user profiles, only subaccount addresses
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // TODO: Implement using Vertex indexer API (archive.vertexprotocol.com)
    // to fetch per-subaccount PnL and portfolio data
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Vertex leaderboard entry.
   * ROI comes as decimal (0.35 = 35%) from the API.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as VertexLeaderboardEntry
    const rawRoi = safeNumber(e.roi)
    // Vertex API likely returns ROI as decimal; convert to percentage
    const roi = rawRoi != null
      ? (Math.abs(rawRoi) <= 10 ? rawRoi * 100 : rawRoi)
      : null
    const pnl = safeNumber(e.pnl)

    return {
      trader_key: (e.subaccount || '').toLowerCase(),
      display_name: e.display_name || null,
      roi,
      pnl,
      platform_rank: e.rank ?? null,
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
