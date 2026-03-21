/**
 * GMX Perpetual DEX Connector
 *
 * Uses GMX's Subgraph (The Graph) for on-chain trading data.
 * Alternative: REST API at arbitrum-api.gmxinfra.io
 *
 * Key notes:
 * - trader_key is an Ethereum/Arbitrum address (0x...)
 * - PnL is in wei (divide by 10^30 for USD on GMX v2)
 * - ROI = realizedPnl / maxCapital (computed client-side)
 * - No copy trading / followers / copiers
 * - Win rate = wins / (wins + losses)
 */

import { BaseConnector } from '../base'
import { safeNumber } from '../utils'
import { warnValidate } from '../schemas'
import {
  GmxLeaderboardResponseSchema,
  GmxSubgraphResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags, TraderTimeseries,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const GMX_DECIMALS = 30  // GMX v2 uses 30 decimals for USD values

export class GmxPerpConnector extends BaseConnector {
  readonly platform = 'gmx' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'gmx',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['pnl', 'win_rate', 'trades_count', 'max_drawdown'],
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: ['On-chain data via Subgraph', 'ROI computed from PnL/maxCapital', 'No profiles', 'trader_key = 0x address'],
  }

  private getSubgraphUrl(): string {
    // Satsuma DNS dead since ~2026-03-15, switched to Squids
    return 'https://gmx.squids.live/gmx-synthetics-arbitrum/graphql'
  }

  private getPeriodPrefix(window: Window): string {
    // GMX subgraph periods: "1d:TIMESTAMP", "1w:TIMESTAMP", "total"
    // For leaderboard, use "total" (all-time) since subgraph doesn't have native 7d/30d/90d periods
    return 'total'
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    // Satsuma subgraph DNS dead since ~2026-03-15, switched to Subsquid (gmx.squids.live)
    // Subsquid uses accountStats with limit/orderBy instead of periodAccountStats with first/where
    const query = `{
      accountStats(
        limit: ${limit}
        orderBy: realizedPnl_DESC
      ) {
        id
        realizedPnl
        volume
        netCapital
        maxCapital
        wins
        losses
        closedCount
      }
    }`

    const _rawLb = await this.request<Record<string, unknown>>(
      this.getSubgraphUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }
    )

    const data = warnValidate(GmxSubgraphResponseSchema, _rawLb, 'gmx-perp/leaderboard')
    // Subsquid returns data.accountStats instead of data.periodAccountStats
    const rankings = (data?.data?.accountStats || data?.data?.periodAccountStats || []) as Record<string, unknown>[]

    const traders: TraderSource[] = (Array.isArray(rankings) ? rankings : []).slice(0, limit).map((item: Record<string, unknown>) => {
      const address = String(item.account || item.id || '').toLowerCase()
      return {
        platform: 'gmx' as const, market_type: 'perp' as const,
        trader_key: address,
        display_name: null,
        profile_url: `https://app.gmx.io/#/leaderboard?account=${address}`,
        discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        is_active: true, raw: item as Record<string, unknown>,
      }
    })

    return { traders, total_available: rankings.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // GMX has no user profiles
    const profile: TraderProfile = {
      platform: 'gmx', market_type: 'perp', trader_key: traderKey.toLowerCase(),
      display_name: null, avatar_url: null,
      bio: null, tags: ['on-chain', 'perp-dex', 'arbitrum'],
      profile_url: `https://app.gmx.io/#/leaderboard?account=${traderKey}`,
      followers: null, copiers: null, aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: null,
      provenance: { source_platform: 'gmx', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // Fetch trader stats from Squids subgraph
    const query = `{
      accountStats(
        limit: 1
        where: { id_containsInsensitive: "${traderKey.toLowerCase()}" }
      ) {
        id realizedPnl maxCapital wins losses closedCount
      }
    }`
    const _rawSnap = await this.request<Record<string, unknown>>(
      this.getSubgraphUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }
    )
    const data = warnValidate(GmxSubgraphResponseSchema, _rawSnap, 'gmx-perp/snapshot')
    const rankings = data?.data?.accountStats || data?.data?.periodAccountStats || []
    const entry = Array.isArray(rankings) ? rankings[0] as Record<string, unknown> | undefined : undefined

    if (!entry) {
      return {
        metrics: { roi: null, pnl: null, win_rate: null, max_drawdown: null, sharpe_ratio: null, sortino_ratio: null, trades_count: null, followers: null, copiers: null, aum: null, platform_rank: null, arena_score: null, return_score: null, drawdown_score: null, stability_score: null },
        quality_flags: { missing_fields: ['roi', 'pnl'], non_standard_fields: {}, window_native: true, notes: ['Trader not found in GMX leaderboard for this window'] },
        fetched_at: new Date().toISOString(),
      }
    }

    const realizedPnl = this.fromGmxDecimals(entry.realizedPnl)
    const maxCapital = this.fromGmxDecimals(entry.maxCapital)
    const wins = Number(entry.wins) || 0
    const losses = Number(entry.losses) || 0
    const totalTrades = wins + losses

    const roi = (maxCapital != null && maxCapital > 0 && realizedPnl != null) ? (realizedPnl / maxCapital) * 100 : null
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null

    const metrics: SnapshotMetrics = {
      roi,
      pnl: realizedPnl,
      win_rate: winRate,
      max_drawdown: null,  // Requires historical equity reconstruction
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: totalTrades || null,
      followers: null, copiers: null,
      aum: maxCapital || null,
      platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }

    const quality_flags: QualityFlags = {
      missing_fields: ['max_drawdown', 'followers', 'copiers', 'sharpe_ratio', 'sortino_ratio'],
      non_standard_fields: {
        roi: 'Computed as realizedPnl / maxCapital. GMX only provides absolute PnL.',
        win_rate: 'Computed from wins/(wins+losses) position count.',
        aum: 'maxCapital used as proxy for AUM (maximum capital deployed)',
      },
      window_native: true,
      notes: [
        'GMX is an on-chain perpetual DEX on Arbitrum',
        'No copy trading - followers/copiers not applicable',
        'Max drawdown requires historical equity curve reconstruction from events',
      ],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    // For timeseries, we'd need the subgraph with daily period stats
    // This is a simplified version using the REST API
    const series: TraderTimeseries[] = []

    // Try to get daily stats from Squids subgraph
    try {
      const query = `{
        periodAccountStats(
          limit: 90
          where: { account_containsInsensitive: "${traderKey.toLowerCase()}", period_startsWith: "1d:" }
          orderBy: period_ASC
        ) {
          period
          realizedPnl
          maxCapital
        }
      }`

      const _rawSubgraph = await this.request<Record<string, unknown>>(
        this.getSubgraphUrl(),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        }
      )
      const data = warnValidate(GmxSubgraphResponseSchema, _rawSubgraph, 'gmx-perp/timeseries')
      const dailyStats = data?.data?.periodAccountStats || []

      if (Array.isArray(dailyStats) && dailyStats.length > 0) {
        series.push({
          platform: 'gmx', market_type: 'perp', trader_key: traderKey.toLowerCase(),
          series_type: 'daily_pnl', as_of_ts: new Date().toISOString(),
          data: dailyStats.map((item: Record<string, unknown>) => {
            // Period format: "1d:TIMESTAMP"
            const ts = String(item.period || '').split(':')[1]
            return {
              ts: ts ? new Date(Number(ts) * 1000).toISOString() : new Date().toISOString(),
              value: this.fromGmxDecimals(item.realizedPnl) ?? 0,
            }
          }),
          updated_at: new Date().toISOString(),
        })
      }
    } catch {
      // Subgraph may not be available, return empty series
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw GMX leaderboard entry.
   * Raw fields: account/id, realizedPnl (BigInt scale 1e30 or USD),
   * maxCapital, wins, losses, closedCount.
   * ROI computed as realizedPnl / maxCapital × 100.
   * win_rate computed as wins / (wins + losses) × 100.
   * max_drawdown: null (GMX API lacks historical equity data for true MDD).
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const pnl = this.fromGmxDecimals(raw.realizedPnl)
    const maxCapital = this.fromGmxDecimals(raw.maxCapital)
    // ROI = realizedPnl / maxCapital × 100
    let roi: number | null = null
    if (pnl != null && maxCapital != null && maxCapital > 100) {
      roi = Math.max(-100, Math.min(10000, (pnl / maxCapital) * 100))
    }
    // Win rate from wins/losses
    const wins = safeNumber(raw.wins) ?? 0
    const losses = safeNumber(raw.losses) ?? 0
    const totalTrades = wins + losses
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null
    const tradesCount = safeNumber(raw.closedCount) ?? (totalTrades > 0 ? totalTrades : null)

    // GMX subgraph does not provide historical equity curve data needed to compute true MDD.
    // netCapital (current capital) vs maxCapital (peak) is not the same as max drawdown.
    // Leave as null — enrichment can derive MDD from equity curve if available.
    const maxDrawdown: number | null = null

    return {
      trader_key: String(raw.account || raw.id || '').toLowerCase(),
      display_name: null,
      avatar_url: null,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: tradesCount,
      followers: null,
      copiers: null,
      aum: (maxCapital != null && maxCapital > 0) ? maxCapital : null,
      sharpe_ratio: null,
      platform_rank: null,
    }
  }

  /**
   * Convert GMX BigInt/decimal values to USD numbers.
   * Returns null (not 0) for missing/invalid data to avoid false-zero ROI.
   */
  private fromGmxDecimals(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const str = String(val)
    const num = Number(str)
    if (!Number.isFinite(num)) return null
    // GMX v2 uses 30 decimals. If value > 1e20, it's in raw form
    if (Math.abs(num) > 1e20) {
      return num / Math.pow(10, GMX_DECIMALS)
    }
    return num
  }
}
