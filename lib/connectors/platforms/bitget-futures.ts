/**
 * Bitget Futures Connector
 *
 * Uses Bitget's public copy trading API.
 * Endpoint: www.bitget.com/v1/trigger/trace/public/currentTrader/list
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  BitgetFuturesLeaderboardResponseSchema,
  BitgetFuturesDetailResponseSchema,
  BitgetFuturesTimeseriesResponseSchema,
} from './schemas'
import type {
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
  TraderProfile,
  SnapshotMetrics,
  QualityFlags,
  TraderTimeseries,
  PlatformCapabilities,
  Window,
} from '../../types/leaderboard'

const WINDOW_MAP: Record<Window, number> = {
  '7d': 1,
  '30d': 2,
  '90d': 3,
}

export class BitgetFuturesConnector extends BaseConnector {
  readonly platform = 'bitget' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'bitget',
    market_types: ['futures', 'spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['CF protected but API accessible', 'Good field coverage'],
  }

  async discoverLeaderboard(window: Window, limit = 20, offset = 0): Promise<DiscoverResult> {
    const timeRange = WINDOW_MAP[window]
    const pageNo = Math.floor(offset / limit) + 1

    const _rawLb = await this.request<any>(
      `https://www.bitget.com/v1/trigger/trace/public/currentTrader/list?pageNo=${pageNo}&pageSize=${limit}&sortType=2&timeRange=${timeRange}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesLeaderboardResponseSchema, _rawLb, 'bitget-futures/leaderboard')

    const rawData = data?.data
    const list = (rawData && 'list' in rawData ? (rawData as Record<string, unknown>).list : rawData) || []

    const traders: TraderSource[] = (Array.isArray(list) ? list : []).map((item: Record<string, unknown>) => ({
      platform: 'bitget' as const,
      market_type: 'futures' as const,
      trader_key: String(item.traderId || ''),
      display_name: (item.traderName as string) || null,
      profile_url: `https://www.bitget.com/copy-trading/trader/${item.traderId}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: item as Record<string, unknown>,
    }))

    return {
      traders,
      total_available: (rawData && 'total' in rawData ? Number((rawData as Record<string, unknown>).total) : null) || null,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<any>(
      `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesDetailResponseSchema, _rawProfile, 'bitget-futures/profile')

    const info = data?.data

    if (!info) return null

    const profile: TraderProfile = {
      platform: 'bitget',
      market_type: 'futures',
      trader_key: traderKey,
      display_name: (info.traderName as string) || null,
      avatar_url: (info.headUrl as string) || null,
      bio: (info.introduction as string) || null,
      tags: [],
      profile_url: `https://www.bitget.com/copy-trading/trader/${traderKey}`,
      followers: this.toInt(info.followerNum),
      copiers: this.toInt(info.copyTraderNum),
      aum: this.parseNumber(info.totalFollowAssets),
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
      provenance: {
        source_platform: 'bitget',
        acquisition_method: 'api',
        fetched_at: new Date().toISOString(),
        source_url: `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderKey}`,
        scraper_version: '1.0.0',
      },
    }

    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const timeRange = WINDOW_MAP[window]

    const _rawSnap = await this.request<any>(
      `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderKey}&timeRange=${timeRange}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesDetailResponseSchema, _rawSnap, 'bitget-futures/snapshot')

    const info = data?.data

    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.parseNumber(info.roi),
      pnl: this.parseNumber(info.profit),
      win_rate: this.parseNumber(info.winRate),
      max_drawdown: this.parseNumber(info.drawDown),
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: this.toInt(info.totalOrder),
      followers: this.toInt(info.followerNum),
      copiers: this.toInt(info.copyTraderNum),
      aum: this.parseNumber(info.totalFollowAssets),
      platform_rank: null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    }

    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio'],
      non_standard_fields: {},
      window_native: true,
      notes: [],
    }

    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    const _rawTs = await this.request<any>(
      `https://www.bitget.com/v1/trigger/trace/public/trader/profitList?traderId=${traderKey}`,
      { method: 'GET' }
    )
    const data = warnValidate(BitgetFuturesTimeseriesResponseSchema, _rawTs, 'bitget-futures/timeseries')

    const profitList = data?.data || []

    const series: TraderTimeseries[] = []

    if (Array.isArray(profitList) && profitList.length > 0) {
      series.push({
        platform: 'bitget',
        market_type: 'futures',
        trader_key: traderKey,
        series_type: 'daily_pnl',
        as_of_ts: new Date().toISOString(),
        data: profitList.map((item: Record<string, unknown>) => ({
          ts: new Date(Number(item.date) || Date.now()).toISOString(),
          value: Number(item.profit) || 0,
        })),
        updated_at: new Date().toISOString(),
      })
    }

    return { series, fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.traderId,
      display_name: raw.traderName,
      roi: this.parseNumber(raw.roi),
      pnl: this.parseNumber(raw.profit),
      win_rate: this.parseNumber(raw.winRate),
      max_drawdown: this.parseNumber(raw.drawDown),
      followers: raw.followerNum,
      copiers: raw.copyTraderNum,
    }
  }

  private parseNumber(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const num = Number(val)
    return isNaN(num) ? null : num
  }

  private toInt(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const num = parseInt(String(val), 10)
    return isNaN(num) ? null : num
  }
}
