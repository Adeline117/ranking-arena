/**
 * MEXC Futures Connector
 *
 * Uses MEXC's copy trading API.
 * Endpoint: futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { MexcFuturesLeaderboardResponseSchema, MexcFuturesDetailResponseSchema } from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, number> = { '7d': 1, '30d': 2, '90d': 3 }

export class MexcFuturesConnector extends BaseConnector {
  readonly platform = 'mexc' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'mexc',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: ['CF protected', 'No timeseries endpoint available'],
  }

  async discoverLeaderboard(window: Window, limit = 20, offset = 0): Promise<DiscoverResult> {
    const page = Math.floor(offset / limit) + 1
    const _rawLb = await this.request<Record<string, unknown>>(
      `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list?page=${page}&pageSize=${limit}&sortField=yield&sortType=DESC&timeType=${WINDOW_MAP[window]}`,
      { method: 'GET' }
    )
    const data = warnValidate(MexcFuturesLeaderboardResponseSchema, _rawLb, 'mexc-futures/leaderboard')
    const list = data?.data?.list || []

    const traders: TraderSource[] = list.map((item: Record<string, unknown>) => ({
      platform: 'mexc' as const,
      market_type: 'futures' as const,
      trader_key: String(item.uid || ''),
      display_name: (item.nickname as string) || null,
      profile_url: `https://futures.mexc.com/copy-trading/trader/${item.uid}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: item as Record<string, unknown>,
    }))

    return { traders, total_available: data?.data?.total || null, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(MexcFuturesDetailResponseSchema, _rawProfile, 'mexc-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'mexc', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null,
      avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://futures.mexc.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount),
      aum: this.num(info.aum),
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'mexc', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/detail?uid=${traderKey}&timeType=${WINDOW_MAP[window]}`,
      { method: 'GET' }
    )
    const data = warnValidate(MexcFuturesDetailResponseSchema, _rawSnap, 'mexc-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.yield), pnl: this.num(info.pnl),
      win_rate: this.num(info.winRate), max_drawdown: this.num(info.maxRetrace),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followerCount), copiers: this.num(info.copyCount),
      aum: this.num(info.aum), platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    // MEXC does not provide public timeseries API
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.uid, display_name: raw.nickname, roi: this.num(raw.yield), pnl: this.num(raw.pnl) }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }
}
