/**
 * MUX Protocol Perpetual Connector
 *
 * Uses MUX Protocol's subgraph on The Graph for trader stats.
 * MUX is a multi-chain perpetual trading aggregator.
 *
 * Key notes:
 * - trader_key is wallet address
 * - Operates on Arbitrum, BNB Chain, Optimism, Avalanche, Fantom
 * - Uses GraphQL subgraph for data
 * - No followers/copiers (DEX - no copy trading)
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface MuxAccount {
  id: string
  cumulativeVolumeUSD?: string
  cumulativePnlUSD?: string
  cumulativeFeeUSD?: string
  openPositionCount?: number
  closedPositionCount?: number
}

export class MuxPerpConnector extends BaseConnector {
  readonly platform = 'mux' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'mux' as any,
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'trades_count'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2, // GraphQL subgraph available
    rate_limit: { rpm: 30, concurrency: 5 },
    notes: ['Multi-chain DEX', 'Arbitrum primary', 'GraphQL subgraph', 'No copy trading'],
  }

  // MUX subgraph on Arbitrum (primary chain)
  private readonly SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/messari/mux-arbitrum'

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    try {
      const query = `
        query GetTopTraders($limit: Int!) {
          accounts(
            first: $limit
            orderBy: cumulativePnlUSD
            orderDirection: desc
            where: { closedPositionCount_gt: 0 }
          ) {
            id
            cumulativeVolumeUSD
            cumulativePnlUSD
            cumulativeFeeUSD
            openPositionCount
            closedPositionCount
          }
        }
      `

      const response = await this.request<{
        data?: { accounts?: MuxAccount[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { limit } }),
      })

      const accounts = response?.data?.accounts || []
      const traders: TraderSource[] = accounts.map((item) => ({
        platform: 'mux' as any,
        market_type: 'perp' as const,
        trader_key: item.id.toLowerCase(),
        display_name: `${item.id.slice(0, 6)}...${item.id.slice(-4)}`,
        profile_url: `https://mux.network/trade?account=${item.id}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: item as unknown as Record<string, unknown>,
      }))

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const query = `
        query GetTraderStats($id: ID!) {
          account(id: $id) {
            id
            cumulativeVolumeUSD
            cumulativePnlUSD
            cumulativeFeeUSD
            openPositionCount
            closedPositionCount
          }
        }
      `

      const response = await this.request<{
        data?: { account?: MuxAccount }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: traderKey.toLowerCase() } }),
      })

      const info = response?.data?.account
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'mux' as any,
        market_type: 'perp',
        trader_key: traderKey.toLowerCase(),
        display_name: `${traderKey.slice(0, 6)}...${traderKey.slice(-4)}`,
        avatar_url: null,
        bio: null,
        tags: ['arbitrum', 'perpetual', 'aggregator', 'multi-chain'],
        profile_url: `https://mux.network/trade?account=${traderKey}`,
        followers: null,
        copiers: null,
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'mux',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: this.SUBGRAPH_URL,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    try {
      const query = `
        query GetTraderStats($id: ID!) {
          account(id: $id) {
            id
            cumulativeVolumeUSD
            cumulativePnlUSD
            cumulativeFeeUSD
            openPositionCount
            closedPositionCount
          }
        }
      `

      const response = await this.request<{
        data?: { account?: MuxAccount }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: traderKey.toLowerCase() } }),
      })

      const info = response?.data?.account
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: false, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      // Calculate metrics from cumulative data
      const pnl = this.parseDecimal(info.cumulativePnlUSD)
      const volume = this.parseDecimal(info.cumulativeVolumeUSD)
      const roi = volume && volume > 0 && pnl !== null ? (pnl / volume) * 100 : null
      const tradesCount = (info.openPositionCount || 0) + (info.closedPositionCount || 0)

      const metrics: SnapshotMetrics = {
        roi,
        pnl,
        win_rate: null,
        max_drawdown: null,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: tradesCount || null,
        followers: null,
        copiers: null,
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags: QualityFlags = {
        missing_fields: ['win_rate', 'max_drawdown', 'sharpe_ratio', 'sortino_ratio', 'followers', 'copiers', 'aum'],
        non_standard_fields: {
          open_positions: String(info.openPositionCount || 0),
          closed_positions: String(info.closedPositionCount || 0),
        },
        window_native: false, // MUX only provides all-time data
        notes: ['MUX Protocol multi-chain DEX', 'All-time stats only', `Window ${window} not natively supported`],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.id,
      pnl: this.parseDecimal(raw.cumulativePnlUSD as string),
      volume: this.parseDecimal(raw.cumulativeVolumeUSD as string),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }

  private parseDecimal(val: string | null | undefined): number | null {
    if (!val) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }
}
