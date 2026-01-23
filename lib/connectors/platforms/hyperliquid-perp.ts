/**
 * Hyperliquid Perpetual DEX Connector
 *
 * Uses Hyperliquid's public REST API.
 * Endpoint: api.hyperliquid.xyz/info
 *
 * Key differences from CEX:
 * - trader_key is an Ethereum address (0x...)
 * - No copy trading / followers / copiers
 * - ROI computed from account value changes
 * - Win rate computed from trade fills
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags, TraderTimeseries,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class HyperliquidPerpConnector extends BaseConnector {
  readonly platform = 'hyperliquid' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'hyperliquid',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: true,
    has_profiles: false,  // No user profiles on DEX
    scraping_difficulty: 1,
    rate_limit: { rpm: 60, concurrency: 3 },
    notes: ['Public REST API', 'No CF', 'trader_key = 0x address', 'No followers/copiers/win_rate natively'],
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    const timeWindow = window === '7d' ? 'day' : window === '30d' ? 'month' : 'allTime'

    const data = await this.request<any>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'leaderboard', timeWindow }),
      }
    )
    const leaderboard = data?.leaderboardRows || data || []

    // For 90d with allTime, we take top entries (platform doesn't have 90d natively, uses allTime)
    const entries = Array.isArray(leaderboard) ? leaderboard.slice(0, limit) : []

    const traders: TraderSource[] = entries.map((item: Record<string, unknown>) => {
      const address = String(item.ethAddress || item.user || '')
      return {
        platform: 'hyperliquid' as const, market_type: 'perp' as const,
        trader_key: address,
        display_name: (item.displayName as string) || null,
        profile_url: `https://app.hyperliquid.xyz/leaderboard/${address}`,
        discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        is_active: true, raw: item as Record<string, unknown>,
      }
    })

    return { traders, total_available: entries.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // Hyperliquid has no user profiles - only addresses
    const profile: TraderProfile = {
      platform: 'hyperliquid', market_type: 'perp', trader_key: traderKey,
      display_name: null,  // Anonymous wallet
      avatar_url: null,
      bio: null, tags: ['on-chain', 'perp-dex'],
      profile_url: `https://app.hyperliquid.xyz/leaderboard/${traderKey}`,
      followers: null, copiers: null, aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: null,
      provenance: { source_platform: 'hyperliquid', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Get clearinghouse state for current equity
    const stateResponse = await this.request<any>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: traderKey }),
      }
    )
    const state = await stateResponse.json()

    const accountValue = Number(state?.marginSummary?.accountValue) || 0
    const totalRawPnl = Number(state?.marginSummary?.totalRawPnl) || 0

    // Compute approximate ROI (this is simplified; proper implementation would track starting equity)
    const roi = accountValue > 0 ? (totalRawPnl / (accountValue - totalRawPnl)) * 100 : null

    const metrics: SnapshotMetrics = {
      roi,
      pnl: totalRawPnl || null,
      win_rate: null,      // Requires computing from individual fills
      max_drawdown: null,  // Requires equity curve history
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: null,
      followers: null,  // DEX - no followers
      copiers: null,    // DEX - no copiers
      aum: accountValue || null,
      platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }

    const quality_flags: QualityFlags = {
      missing_fields: ['win_rate', 'max_drawdown', 'followers', 'copiers', 'sharpe_ratio', 'sortino_ratio'],
      non_standard_fields: {
        roi: 'Computed from current account state, not windowed historical. Window accuracy depends on data refresh frequency.',
      },
      window_native: window === '30d',  // Only 'month' is truly native
      notes: [
        'Hyperliquid is a DEX - no copy trading features',
        'ROI computed from clearinghouse state (approximate for windows other than 30d)',
        'Win rate requires trade-level analysis of fills',
      ],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    // Get user fills for trade history
    const fillsResponse = await this.request<any>(
      'https://api.hyperliquid.xyz/info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFills', user: traderKey }),
      }
    )
    const fills = await fillsResponse.json()

    const series: TraderTimeseries[] = []

    if (Array.isArray(fills) && fills.length > 0) {
      // Aggregate fills by day for daily PnL
      const dailyPnl = new Map<string, number>()
      for (const fill of fills) {
        const date = new Date(Number(fill.time) || Date.now()).toISOString().split('T')[0]
        const pnl = Number(fill.closedPnl) || 0
        dailyPnl.set(date, (dailyPnl.get(date) || 0) + pnl)
      }

      series.push({
        platform: 'hyperliquid', market_type: 'perp', trader_key: traderKey,
        series_type: 'daily_pnl', as_of_ts: new Date().toISOString(),
        data: Array.from(dailyPnl.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, value]) => ({ ts: `${date}T00:00:00Z`, value })),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.ethAddress || raw.user,
      display_name: raw.displayName || null,
      pnl: Number(raw.accountValue) || null,
    }
  }
}
