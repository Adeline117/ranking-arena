/**
 * BloFin Futures Connector
 *
 * BloFin has copy trading with authenticated API but leaderboard not clearly public.
 * This connector attempts to use their API patterns.
 *
 * Key notes:
 * - trader_key is BloFin UID
 * - Has copy trading at blofin.com/en/copy-trade
 * - API may require authentication for leaderboard data
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  BlofinFuturesLeaderboardResponseSchema,
  BlofinFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface BloFinTraderEntry {
  traderId?: string
  nickName?: string
  avatar?: string
  roi?: number
  pnl?: number
  followers?: number
  winRate?: number
  sharpeRatio?: number
  maxDrawdown?: number
}

export class BlofinFuturesConnector extends BaseConnector {
  readonly platform = 'blofin' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'blofin',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'sharpe_ratio', 'followers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: ['Copy trading platform', 'API may require auth', 'Good metrics coverage'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Origin': 'https://blofin.com',
      'Referer': 'https://blofin.com/en/copy-trade',
    }
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    const period = periodMap[window] || '30'

    try {
      // Attempt BloFin API endpoint
      const _rawLb = await this.request<{ data?: { list?: BloFinTraderEntry[] } }>(
        `https://openapi.blofin.com/api/v1/copytrading/public/leaderboard?period=${period}&limit=${limit}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(BlofinFuturesLeaderboardResponseSchema, _rawLb, 'blofin-futures/leaderboard')

      const list = data?.data?.list || []
      const traders: TraderSource[] = list.map((item) => ({
        platform: 'blofin',
        market_type: 'futures' as const,
        trader_key: String(item.traderId || ''),
        display_name: item.nickName || null,
        profile_url: `https://blofin.com/en/copy-trade/details/${item.traderId}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: item as Record<string, unknown>,
      }))

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const _rawProfile = await this.request<{ data?: BloFinTraderEntry }>(
        `https://openapi.blofin.com/api/v1/copytrading/public/trader/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(BlofinFuturesDetailResponseSchema, _rawProfile, 'blofin-futures/profile')

      const info = data?.data
      const profile: TraderProfile = {
        platform: 'blofin',
        market_type: 'futures',
        trader_key: traderKey,
        display_name: info?.nickName || null,
        avatar_url: info?.avatar || null,
        bio: null,
        tags: ['copy-trading', 'futures'],
        profile_url: `https://blofin.com/en/copy-trade/details/${traderKey}`,
        followers: this.num(info?.followers),
        copiers: null,
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'blofin',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: null,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' }
    const period = periodMap[window] || '30'

    try {
      const _rawSnap = await this.request<{ data?: BloFinTraderEntry }>(
        `https://openapi.blofin.com/api/v1/copytrading/public/trader/${traderKey}?period=${period}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(BlofinFuturesDetailResponseSchema, _rawSnap, 'blofin-futures/snapshot')

      const info = data?.data
      if (!info) {
        return {
          metrics: this.emptyMetrics(),
          quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: true, notes: ['Trader not found'] },
          fetched_at: new Date().toISOString(),
        }
      }

      const metrics: SnapshotMetrics = {
        roi: this.num(info.roi),
        pnl: this.num(info.pnl),
        win_rate: this.num(info.winRate),
        max_drawdown: this.num(info.maxDrawdown),
        sharpe_ratio: this.num(info.sharpeRatio),
        sortino_ratio: null,
        trades_count: null,
        followers: this.num(info.followers),
        copiers: null,
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags: QualityFlags = {
        missing_fields: ['sortino_ratio', 'trades_count', 'copiers', 'aum'],
        non_standard_fields: {},
        window_native: true,
        notes: ['BloFin copy trading platform'],
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
      trader_key: raw.traderId,
      display_name: raw.nickName,
      roi: this.num(raw.roi),
      pnl: this.num(raw.pnl),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }
}
