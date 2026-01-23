/**
 * dYdX v4 Perpetual DEX Connector
 *
 * Uses dYdX v4 indexer API.
 * Endpoint: indexer.dydx.trade/v4/
 *
 * Key notes:
 * - dYdX leaderboard sorts by PnL (not ROI) - we compute ROI client-side
 * - trader_key is a dydx1... or 0x... address
 * - No copy trading / followers / copiers
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags, TraderTimeseries,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, string> = { '7d': 'PERIOD_7D', '30d': 'PERIOD_30D', '90d': 'PERIOD_90D' }

export class DydxPerpConnector extends BaseConnector {
  readonly platform = 'dydx' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'dydx',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['pnl'],  // ROI computed client-side
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 60, concurrency: 3 },
    notes: ['Public indexer API', 'PnL-sorted only (ROI computed)', 'No profiles', 'All windows supported'],
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    const period = WINDOW_MAP[window]
    const data = await this.request<any>(
      `https://indexer.dydx.trade/v4/leaderboard/pnl?period=${period}&limit=${limit}`,
      { method: 'GET' }
    )
    const rankings = data?.pnlRanking || []

    const traders: TraderSource[] = (Array.isArray(rankings) ? rankings : []).map((item: Record<string, unknown>) => {
      const address = String(item.address || '')
      return {
        platform: 'dydx' as const, market_type: 'perp' as const,
        trader_key: address,
        display_name: null,  // dYdX has no display names
        profile_url: `https://trade.dydx.exchange/portfolio/${address}`,
        discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        is_active: true, raw: item as Record<string, unknown>,
      }
    })

    return { traders, total_available: rankings.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // dYdX has no user profiles - only addresses
    const profile: TraderProfile = {
      platform: 'dydx', market_type: 'perp', trader_key: traderKey,
      display_name: null, avatar_url: null,
      bio: null, tags: ['on-chain', 'perp-dex'],
      profile_url: `https://trade.dydx.exchange/portfolio/${traderKey}`,
      followers: null, copiers: null, aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: null,
      provenance: { source_platform: 'dydx', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Get subaccount for equity
    const subResponse = await this.request<any>(
      `https://indexer.dydx.trade/v4/addresses/${traderKey}/subaccounts/0`,
      { method: 'GET' }
    )
    const subData = await subResponse.json()
    const equity = Number(subData?.subaccount?.equity) || 0

    // Get PnL from leaderboard for this address
    const period = WINDOW_MAP[window]
    const lbResponse = await this.request<any>(
      `https://indexer.dydx.trade/v4/leaderboard/pnl?period=${period}&limit=1000`,
      { method: 'GET' }
    )
    const lbData = await lbResponse.json()
    const rankings = lbData?.pnlRanking || []
    const entry = rankings.find((r: Record<string, unknown>) => String(r.address) === traderKey)

    const pnl = entry ? Number(entry.pnl) || null : null
    // Approximate ROI: PnL / (equity - pnl) if possible
    const startEquity = equity - (pnl || 0)
    const roi = startEquity > 0 && pnl !== null ? (pnl / startEquity) * 100 : null

    const metrics: SnapshotMetrics = {
      roi,
      pnl,
      win_rate: null,
      max_drawdown: null,
      sharpe_ratio: null, sortino_ratio: null,
      trades_count: null,
      followers: null, copiers: null,
      aum: equity || null,
      platform_rank: entry ? Number(entry.rank) || null : null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }

    const quality_flags: QualityFlags = {
      missing_fields: ['win_rate', 'max_drawdown', 'followers', 'copiers', 'sharpe_ratio', 'sortino_ratio', 'trades_count'],
      non_standard_fields: {
        roi: 'Computed from PnL / starting equity. dYdX only provides absolute PnL in leaderboard.',
      },
      window_native: true,
      notes: [
        'dYdX is a DEX - no copy trading',
        'ROI is derived (PnL/equity), not platform-provided',
        'Win rate requires trade-level fill analysis',
      ],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    const data = await this.request<any>(
      `https://indexer.dydx.trade/v4/historical-pnl?address=${traderKey}&subaccountNumber=0&limit=90`,
      { method: 'GET' }
    )
    const historicalPnl = data?.historicalPnl || []

    const series: TraderTimeseries[] = []

    if (Array.isArray(historicalPnl) && historicalPnl.length > 0) {
      series.push({
        platform: 'dydx', market_type: 'perp', trader_key: traderKey,
        series_type: 'daily_pnl', as_of_ts: new Date().toISOString(),
        data: historicalPnl.map((item: Record<string, unknown>) => ({
          ts: String(item.createdAt || new Date().toISOString()),
          value: Number(item.totalPnl) || 0,
        })).reverse(),  // API returns newest first
        updated_at: new Date().toISOString(),
      })

      // Compute equity curve from cumulative PnL
      let cumPnl = 0
      series.push({
        platform: 'dydx', market_type: 'perp', trader_key: traderKey,
        series_type: 'equity_curve', as_of_ts: new Date().toISOString(),
        data: historicalPnl.reverse().map((item: Record<string, unknown>) => {
          cumPnl += Number(item.totalPnl) || 0
          return { ts: String(item.createdAt || new Date().toISOString()), value: cumPnl }
        }),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.address, pnl: Number(raw.pnl) || null }
  }
}
