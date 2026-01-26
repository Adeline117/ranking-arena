/**
 * Kwenta Perpetual Connector
 *
 * Uses Kwenta's subgraph on The Graph (Optimism) for trader stats.
 *
 * Key notes:
 * - trader_key is wallet address on Optimism
 * - Uses GraphQL subgraph: api.thegraph.com/subgraphs/name/kwenta/optimism-perps
 * - Has FuturesStat entity with pnl, totalVolume, totalTrades, etc.
 * - No followers/copiers (DEX - no copy trading)
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface KwentaFuturesStat {
  id: string
  account: string
  pnl: string
  pnlWithFeesPaid: string
  totalVolume: string
  feesPaid: string
  liquidations: string
  totalTrades: string
  smartMarginVolume?: string
}

export class KwentaPerpConnector extends BaseConnector {
  readonly platform = 'kwenta' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'kwenta' as any,
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'trades_count'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2, // GraphQL subgraph available
    rate_limit: { rpm: 30, concurrency: 5 },
    notes: ['Optimism DEX', 'Synthetix-powered', 'GraphQL subgraph', 'No copy trading'],
  }

  private readonly SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/kwenta/optimism-perps'

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    try {
      const query = `
        query GetTopTraders($limit: Int!) {
          futuresStats(
            first: $limit
            orderBy: pnlWithFeesPaid
            orderDirection: desc
            where: { totalTrades_gt: 0 }
          ) {
            id
            account
            pnl
            pnlWithFeesPaid
            totalVolume
            feesPaid
            liquidations
            totalTrades
          }
        }
      `

      const response = await this.request<{
        data?: { futuresStats?: KwentaFuturesStat[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { limit } }),
      })

      const stats = response?.data?.futuresStats || []
      const traders: TraderSource[] = stats.map((item) => ({
        platform: 'kwenta' as any,
        market_type: 'perp' as const,
        trader_key: item.account.toLowerCase(),
        display_name: `${item.account.slice(0, 6)}...${item.account.slice(-4)}`,
        profile_url: `https://kwenta.io/stats/${item.account}`,
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
        query GetTraderStats($account: String!) {
          futuresStats(where: { account: $account }) {
            id
            account
            pnl
            pnlWithFeesPaid
            totalVolume
            feesPaid
            liquidations
            totalTrades
          }
        }
      `

      const response = await this.request<{
        data?: { futuresStats?: KwentaFuturesStat[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { account: traderKey.toLowerCase() } }),
      })

      const info = response?.data?.futuresStats?.[0]
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'kwenta' as any,
        market_type: 'perp',
        trader_key: traderKey.toLowerCase(),
        display_name: `${traderKey.slice(0, 6)}...${traderKey.slice(-4)}`,
        avatar_url: null,
        bio: null,
        tags: ['optimism', 'perpetual', 'synthetix'],
        profile_url: `https://kwenta.io/stats/${traderKey}`,
        followers: null,
        copiers: null,
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'kwenta',
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
        query GetTraderStats($account: String!) {
          futuresStats(where: { account: $account }) {
            id
            account
            pnl
            pnlWithFeesPaid
            totalVolume
            feesPaid
            liquidations
            totalTrades
          }
        }
      `

      const response = await this.request<{
        data?: { futuresStats?: KwentaFuturesStat[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { account: traderKey.toLowerCase() } }),
      })

      const info = response?.data?.futuresStats?.[0]
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: false, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      // Note: Kwenta subgraph only provides all-time stats, not windowed
      const pnl = this.parseDecimal(info.pnlWithFeesPaid)
      const volume = this.parseDecimal(info.totalVolume)
      const roi = volume && volume > 0 && pnl !== null ? (pnl / volume) * 100 : null

      const metrics: SnapshotMetrics = {
        roi,
        pnl,
        win_rate: null, // Not available in subgraph
        max_drawdown: null,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: this.num(info.totalTrades),
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
        non_standard_fields: {},
        window_native: false, // Kwenta only provides all-time data
        notes: ['Kwenta Optimism DEX', 'All-time stats only', `Window ${window} not natively supported`],
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
      trader_key: raw.account,
      pnl: this.parseDecimal(raw.pnlWithFeesPaid as string),
      trades_count: this.num(raw.totalTrades),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }

  private parseDecimal(val: string | null | undefined): number | null {
    if (!val) return null
    // Subgraph returns values in wei (18 decimals)
    const n = Number(val) / 1e18
    return isNaN(n) ? null : n
  }
}
