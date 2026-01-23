/**
 * CoinEx Futures Connector
 *
 * Uses CoinEx's copy trading API.
 * Note: CoinEx does NOT support 90d window.
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class CoinexFuturesConnector extends BaseConnector {
  readonly platform = 'coinex' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'coinex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],  // No 90d
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['No 90d window', 'No timeseries endpoint'],
  }

  async discoverLeaderboard(window: Window, limit = 20, offset = 0): Promise<DiscoverResult> {
    // CoinEx does not support 90d
    if (window === '90d') {
      return {
        traders: [], total_available: 0, window,
        fetched_at: new Date().toISOString(),
      }
    }

    const page = Math.floor(offset / limit) + 1
    const data = await this.request<any>(
      `https://www.coinex.com/res/copy-trading/traders?page=${page}&limit=${limit}&sort_by=roi&period=${window}`,
      { method: 'GET' }
    )
    const list = data?.data?.items || []

    const traders: TraderSource[] = (Array.isArray(list) ? list : []).map((item: Record<string, unknown>) => ({
      platform: 'coinex' as const, market_type: 'futures' as const,
      trader_key: String(item.trader_id || ''),
      display_name: (item.nickname as string) || null,
      profile_url: `https://www.coinex.com/copy-trading/trader/${item.trader_id}`,
      discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      is_active: true, raw: item as Record<string, unknown>,
    }))

    return { traders, total_available: data?.data?.total || null, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const data = await this.request<any>(
      `https://www.coinex.com/res/copy-trading/trader/${traderKey}/detail`,
      { method: 'GET' }
    )
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'coinex', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.coinex.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followers), copiers: this.num(info.copiers),
      aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'coinex', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    if (window === '90d') {
      // Platform does not support 90d
      const metrics: SnapshotMetrics = {
        roi: null, pnl: null, win_rate: null, max_drawdown: null,
        sharpe_ratio: null, sortino_ratio: null, trades_count: null,
        followers: null, copiers: null, aum: null, platform_rank: null,
        arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
      }
      const quality_flags: QualityFlags = {
        missing_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown'],
        non_standard_fields: {},
        window_native: false,
        notes: ['CoinEx does not provide 90-day window data'],
      }
      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    }

    const data = await this.request<any>(
      `https://www.coinex.com/res/copy-trading/trader/${traderKey}/detail?period=${window}`,
      { method: 'GET' }
    )
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.roi), pnl: this.num(info.profit),
      win_rate: this.num(info.win_rate), max_drawdown: this.num(info.max_drawdown),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followers), copiers: this.num(info.copiers),
      aum: null, platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count', 'aum'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.trader_id, display_name: raw.nickname, roi: this.num(raw.roi), pnl: this.num(raw.profit) }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return isNaN(n) ? null : n
  }
}
