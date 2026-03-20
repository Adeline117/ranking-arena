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
import { warnValidate } from '../schemas'
import {
  MuxAccountsResponseSchema,
  MuxAccountResponseSchema,
  MuxPositionsResponseSchema,
} from './schemas'
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

interface MuxPosition {
  id: string
  account: string
  collateralToken: string
  indexToken: string
  isLong: boolean
  sizeUSD: string
  collateralUSD: string
  realisedPnlUSD: string
  closedAtTimestamp?: string
  status: string
}

export class MuxPerpConnector extends BaseConnector {
  readonly platform = 'mux' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'mux',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'trades_count'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2, // GraphQL subgraph available
    rate_limit: { rpm: 30, concurrency: 5 },
    notes: ['Multi-chain DEX', 'Arbitrum primary', 'GraphQL subgraph', 'No copy trading', 'Metrics calculated from position history'],
  }

  // MUX subgraph on Arbitrum — Graph Network gateway (requires THEGRAPH_API_KEY)
  // Old hosted service URL (deprecated): https://api.thegraph.com/subgraphs/name/messari/mux-arbitrum
  // Subgraph ID: find on https://thegraph.com/explorer by searching "mux"
  private get SUBGRAPH_URL(): string {
    const apiKey = process.env.THEGRAPH_API_KEY
    // MUX Arbitrum subgraph ID (Messari deployment)
    const subgraphId = process.env.MUX_SUBGRAPH_ID || '8v1fBiN7BWDjb9DpH9bUKGJfv7N1H9PJbsRQpqe7JEtc'
    if (apiKey) {
      return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`
    }
    // Fallback to old hosted service (may be deprecated/down)
    return 'https://api.thegraph.com/subgraphs/name/messari/mux-arbitrum'
  }

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

      const _rawLb = await this.request<{
        data?: { accounts?: MuxAccount[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { limit } }),
      })
      const response = warnValidate(MuxAccountsResponseSchema, _rawLb, 'mux-perp/discover')

      const accounts = response?.data?.accounts || []
      const traders: TraderSource[] = accounts.map((item) => ({
        platform: 'mux',
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

      const _rawProfile = await this.request<{
        data?: { account?: MuxAccount }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: traderKey.toLowerCase() } }),
      })
      const response = warnValidate(MuxAccountResponseSchema, _rawProfile, 'mux-perp/profile')

      const info = response?.data?.account
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'mux',
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
      // Get account stats
      const accountQuery = `
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

      // Get closed positions for win rate and drawdown calculation
      const windowDays = window === '7d' ? 7 : window === '30d' ? 30 : 90
      const windowStart = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000)

      const positionsQuery = `
        query GetTraderPositions($account: String!, $windowStart: BigInt!) {
          positions(
            where: {
              account: $account,
              status: "closed",
              closedAtTimestamp_gte: $windowStart
            }
            orderBy: closedAtTimestamp
            orderDirection: asc
            first: 1000
          ) {
            id
            account
            isLong
            sizeUSD
            collateralUSD
            realisedPnlUSD
            closedAtTimestamp
            status
          }
        }
      `

      const [_rawAccount, _rawPositions] = await Promise.all([
        this.request<{ data?: { account?: MuxAccount } }>(this.SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: accountQuery, variables: { id: traderKey.toLowerCase() } }),
        }),
        this.request<{ data?: { positions?: MuxPosition[] } }>(this.SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: positionsQuery, variables: { account: traderKey.toLowerCase(), windowStart: String(windowStart) } }),
        }),
      ])
      const accountResponse = warnValidate(MuxAccountResponseSchema, _rawAccount, 'mux-perp/snapshot-account')
      const positionsResponse = warnValidate(MuxPositionsResponseSchema, _rawPositions, 'mux-perp/snapshot-positions')

      const info = accountResponse?.data?.account
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: false, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      const positions = positionsResponse?.data?.positions || []

      // Calculate metrics from positions within window
      let windowPnl = 0
      let windowVolume = 0
      let winningTrades = 0
      let totalTrades = 0
      let maxEquity = 0
      let minEquityFromPeak = 0
      let runningEquity = 0

      for (const pos of positions) {
        const realizedPnl = this.parseDecimal(pos.realisedPnlUSD) || 0
        const sizeUSD = this.parseDecimal(pos.sizeUSD) || 0

        windowPnl += realizedPnl
        windowVolume += sizeUSD
        totalTrades++

        if (realizedPnl > 0) {
          winningTrades++
        }

        // Track equity curve for drawdown
        runningEquity += realizedPnl
        if (runningEquity > maxEquity) {
          maxEquity = runningEquity
        }
        const drawdownFromPeak = maxEquity - runningEquity
        if (drawdownFromPeak > minEquityFromPeak) {
          minEquityFromPeak = drawdownFromPeak
        }
      }

      // Use window data if available, otherwise fall back to all-time
      const pnl = totalTrades > 0 ? windowPnl : this.parseDecimal(info.cumulativePnlUSD)
      const volume = totalTrades > 0 ? windowVolume : this.parseDecimal(info.cumulativeVolumeUSD)
      const roi = volume && volume > 0 && pnl !== null ? (pnl / volume) * 100 : null
      const tradesCount = totalTrades > 0 ? totalTrades : ((info.openPositionCount || 0) + (info.closedPositionCount || 0))

      // Calculate win rate from window positions
      const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : null

      // Calculate max drawdown
      const maxDrawdown = maxEquity > 0 ? (minEquityFromPeak / maxEquity) * 100 : null

      const metrics: SnapshotMetrics = {
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
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

      const missingFields: string[] = ['sharpe_ratio', 'sortino_ratio', 'followers', 'copiers', 'aum']
      const hasWindowData = totalTrades > 0

      const quality_flags: QualityFlags = {
        missing_fields: missingFields,
        non_standard_fields: {
          open_positions: String(info.openPositionCount || 0),
          closed_positions: String(info.closedPositionCount || 0),
        },
        window_native: hasWindowData,
        notes: [
          'MUX Protocol multi-chain DEX',
          hasWindowData ? `${totalTrades} trades in ${window} window` : 'All-time stats (no trades in window)',
          'Win rate and MDD calculated from position history',
        ],
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
    return !Number.isFinite(n) ? null : n
  }

  private parseDecimal(val: string | null | undefined): number | null {
    if (!val) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}
