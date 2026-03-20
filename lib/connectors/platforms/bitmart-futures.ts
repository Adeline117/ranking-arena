/**
 * BitMart Futures Connector
 * Note: BitMart does NOT support 90d window.
 * Note: BitMart does NOT provide win_rate or max_drawdown in list endpoint.
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  BitmartFuturesLeaderboardResponseSchema,
  BitmartFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class BitmartFuturesConnector extends BaseConnector {
  readonly platform = 'bitmart' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'bitmart',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],  // No 90d
    available_fields: ['roi', 'pnl', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: ['No 90d window', 'No win_rate/drawdown in list endpoint', 'Aggressive CF'],
  }

  async discoverLeaderboard(window: Window, limit = 20, offset = 0): Promise<DiscoverResult> {
    if (window === '90d') {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
    const page = Math.floor(offset / limit) + 1
    const _rawLb = await this.request<Record<string, unknown>>(
      `https://www.bitmart.com/api/copy-trade/v1/public/trader/list?page=${page}&size=${limit}&sortBy=roi&period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitmartFuturesLeaderboardResponseSchema, _rawLb, 'bitmart-futures/leaderboard')
    const list = data?.data?.list || []

    const traders: TraderSource[] = (Array.isArray(list) ? list : []).map((item: Record<string, unknown>) => ({
      platform: 'bitmart' as const, market_type: 'futures' as const,
      trader_key: String(item.traderId || ''), display_name: (item.nickname as string) || null,
      profile_url: `https://www.bitmart.com/copy-trading/trader/${item.traderId}`,
      discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      is_active: true, raw: item as Record<string, unknown>,
    }))
    return { traders, total_available: null, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.bitmart.com/api/copy-trade/v1/public/trader/detail?traderId=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitmartFuturesDetailResponseSchema, _rawProfile, 'bitmart-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'bitmart', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null, avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.bitmart.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followers), copiers: this.num(info.copiers), aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'bitmart', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    if (window === '90d') {
      return {
        metrics: { roi: null, pnl: null, win_rate: null, max_drawdown: null, sharpe_ratio: null, sortino_ratio: null, trades_count: null, followers: null, copiers: null, aum: null, platform_rank: null, arena_score: null, return_score: null, drawdown_score: null, stability_score: null },
        quality_flags: { missing_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown'], non_standard_fields: {}, window_native: false, notes: ['BitMart does not provide 90-day window'] },
        fetched_at: new Date().toISOString(),
      }
    }
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.bitmart.com/api/copy-trade/v1/public/trader/detail?traderId=${traderKey}&period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitmartFuturesDetailResponseSchema, _rawSnap, 'bitmart-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.roi), pnl: this.num(info.pnl),
      win_rate: null, max_drawdown: null,  // Not provided by BitMart
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followers), copiers: this.num(info.copiers),
      aum: null, platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['win_rate', 'max_drawdown', 'sharpe_ratio', 'sortino_ratio', 'trades_count'],
      non_standard_fields: {}, window_native: true,
      notes: ['BitMart does not provide win_rate or max_drawdown in API response'],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.traderId, display_name: raw.nickname, roi: this.num(raw.roi), pnl: this.num(raw.pnl) }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return !Number.isFinite(n) ? null : n
  }
}
