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
import { warnValidate } from '../schemas'
import {
  KwentaStatsResponseSchema,
  KwentaPositionsResponseSchema,
} from './schemas'
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

interface KwentaFuturesPosition {
  id: string
  account: string
  isOpen: boolean
  entryPrice: string
  exitPrice?: string
  size: string
  realizedPnl: string
  netFunding: string
  feesPaid: string
  openTimestamp: string
  closeTimestamp?: string
}

export class KwentaPerpConnector extends BaseConnector {
  readonly platform = 'kwenta' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'kwenta',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'trades_count'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2, // GraphQL subgraph available
    rate_limit: { rpm: 30, concurrency: 5 },
    notes: ['Optimism DEX', 'Synthetix-powered', 'GraphQL subgraph', 'No copy trading', 'Metrics calculated from position history'],
  }

  // Kwenta subgraph — Graph Network gateway (requires THEGRAPH_API_KEY)
  private get SUBGRAPH_URL(): string {
    const apiKey = process.env.THEGRAPH_API_KEY
    const subgraphId = process.env.KWENTA_SUBGRAPH_ID || '' // Find on thegraph.com/explorer
    if (apiKey && subgraphId) {
      return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`
    }
    // Fallback to old hosted service (deprecated, may return 301)
    return 'https://api.thegraph.com/subgraphs/name/kwenta/optimism-perps'
  }

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

      const _rawLb = await this.request<{
        data?: { futuresStats?: KwentaFuturesStat[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { limit } }),
      })
      const response = warnValidate(KwentaStatsResponseSchema, _rawLb, 'kwenta-perp/leaderboard')

      const stats = response?.data?.futuresStats || []
      const traders: TraderSource[] = stats.map((item) => ({
        platform: 'kwenta',
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
    } catch (err) {
      this.logger.warn('Kwenta leaderboard fetch failed:', err instanceof Error ? err.message : String(err))
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

      const _rawProfile = await this.request<{
        data?: { futuresStats?: KwentaFuturesStat[] }
      }>(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { account: traderKey.toLowerCase() } }),
      })
      const response = warnValidate(KwentaStatsResponseSchema, _rawProfile, 'kwenta-perp/profile')

      const info = response?.data?.futuresStats?.[0]
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'kwenta',
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
    } catch (err) {
      this.logger.debug('Kwenta profile fetch failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    try {
      // Get trader stats
      const statsQuery = `
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

      // Get closed positions for win rate and drawdown calculation
      const windowDays = window === '7d' ? 7 : window === '30d' ? 30 : 90
      const windowStart = Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000)

      const positionsQuery = `
        query GetTraderPositions($account: String!, $windowStart: BigInt!) {
          futuresPositions(
            where: {
              account: $account,
              isOpen: false,
              closeTimestamp_gte: $windowStart
            }
            orderBy: closeTimestamp
            orderDirection: asc
            first: 1000
          ) {
            id
            account
            isOpen
            entryPrice
            exitPrice
            size
            realizedPnl
            netFunding
            feesPaid
            openTimestamp
            closeTimestamp
          }
        }
      `

      const [_rawStats, _rawPositions] = await Promise.all([
        this.request<{ data?: { futuresStats?: KwentaFuturesStat[] } }>(this.SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: statsQuery, variables: { account: traderKey.toLowerCase() } }),
        }),
        this.request<{ data?: { futuresPositions?: KwentaFuturesPosition[] } }>(this.SUBGRAPH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: positionsQuery, variables: { account: traderKey.toLowerCase(), windowStart: String(windowStart) } }),
        }),
      ])
      const statsResponse = warnValidate(KwentaStatsResponseSchema, _rawStats, 'kwenta-perp/stats')
      const positionsResponse = warnValidate(KwentaPositionsResponseSchema, _rawPositions, 'kwenta-perp/positions')

      const info = statsResponse?.data?.futuresStats?.[0]
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: false, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      const positions = positionsResponse?.data?.futuresPositions || []

      // Calculate metrics from positions within window
      let windowPnl = 0
      let windowVolume = 0
      let winningTrades = 0
      let totalTrades = 0
      let maxEquity = 0
      let minEquityFromPeak = 0
      let runningEquity = 0

      for (const pos of positions) {
        const realizedPnl = this.parseDecimal(pos.realizedPnl) || 0
        const size = Math.abs(this.parseDecimal(pos.size) || 0)
        const entryPrice = this.parseDecimal(pos.entryPrice) || 0
        const positionValue = size * entryPrice

        windowPnl += realizedPnl
        windowVolume += positionValue
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
      const pnl = totalTrades > 0 ? windowPnl : this.parseDecimal(info.pnlWithFeesPaid)
      const volume = totalTrades > 0 ? windowVolume : this.parseDecimal(info.totalVolume)
      const roi = volume && volume > 0 && pnl !== null ? (pnl / volume) * 100 : null

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
        trades_count: totalTrades > 0 ? totalTrades : this.num(info.totalTrades),
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
        non_standard_fields: { liquidations: info.liquidations ?? '' },
        window_native: hasWindowData,
        notes: [
          'Kwenta Optimism DEX',
          hasWindowData ? `${totalTrades} trades in ${window} window` : 'All-time stats (no trades in window)',
          'Win rate and MDD calculated from position history',
        ],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch (err) {
      this.logger.debug('Kwenta snapshot fetch failed:', err instanceof Error ? err.message : String(err))
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
    return !Number.isFinite(n) ? null : n
  }

  private parseDecimal(val: string | null | undefined): number | null {
    if (!val) return null
    // Subgraph returns values in wei (18 decimals)
    const n = Number(val) / 1e18
    return !Number.isFinite(n) ? null : n
  }
}
