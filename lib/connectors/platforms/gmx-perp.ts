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
    available_fields: ['pnl', 'win_rate', 'trades_count'],
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: ['On-chain data via Subgraph', 'ROI computed from PnL/maxCapital', 'No profiles', 'trader_key = 0x address'],
  }

  private getSubgraphUrl(): string {
    // Use REST API endpoint as primary (more reliable than subgraph for high-volume)
    return 'https://arbitrum-api.gmxinfra.io'
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    // Use the REST leaderboard endpoint
    const data = await this.request<any>(
      `${this.getSubgraphUrl()}/leaderboard/pnl?period=${window}&limit=${limit}`,
      { method: 'GET' }
    )
    const rankings = Array.isArray(data) ? data : (data?.accounts || [])

    const traders: TraderSource[] = rankings.slice(0, limit).map((item: Record<string, unknown>) => {
      const address = String(item.account || item.id || '').toLowerCase()
      return {
        platform: 'gmx' as const, market_type: 'perp' as const,
        trader_key: address,
        display_name: null,  // On-chain = no display name
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

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const data = await this.request<any>(
      `${this.getSubgraphUrl()}/leaderboard/pnl?period=${window}&limit=1000`,
      { method: 'GET' }
    )
    const rankings = Array.isArray(data) ? data : (data?.accounts || [])

    const entry = rankings.find((r: Record<string, unknown>) =>
      String(r.account || r.id || '').toLowerCase() === traderKey.toLowerCase()
    )

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

    const roi = maxCapital > 0 ? (realizedPnl / maxCapital) * 100 : null
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null

    const metrics: SnapshotMetrics = {
      roi,
      pnl: realizedPnl || null,
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

    // Try to get daily stats from subgraph
    try {
      const query = `{
        periodAccountStats(
          where: { account: "${traderKey.toLowerCase()}", period_starts_with: "1d:" }
          orderBy: period
          orderDirection: asc
          first: 90
        ) {
          period
          realizedPnl
          maxCapital
        }
      }`

      const data = await this.request<any>(
        'https://subgraph.satsuma-prod.com/gmx/synthetics-arbitrum-stats/api',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        }
      )
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
              value: this.fromGmxDecimals(item.realizedPnl),
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

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: String(raw.account || raw.id || '').toLowerCase(),
      pnl: this.fromGmxDecimals(raw.realizedPnl),
      max_capital: this.fromGmxDecimals(raw.maxCapital),
    }
  }

  private fromGmxDecimals(val: unknown): number {
    if (val === null || val === undefined) return 0
    const str = String(val)
    const num = Number(str)
    if (isNaN(num)) return 0
    // GMX v2 uses 30 decimals. If value > 1e20, it's in raw form
    if (Math.abs(num) > 1e20) {
      return num / Math.pow(10, GMX_DECIMALS)
    }
    return num
  }
}
