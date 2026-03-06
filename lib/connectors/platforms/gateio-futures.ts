/**
 * Gate.io Futures Connector
 *
 * Uses Gate.io's copy trading API endpoints.
 *
 * Key notes:
 * - trader_key is Gate.io UID
 * - Has copy trading / strategy bot features
 * - May require API exploration for exact endpoints
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  GateioFuturesLeaderboardResponseSchema,
  GateioFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface GateioLeaderboardEntry {
  uid?: string
  nickname?: string
  avatar?: string
  roi?: number
  pnl?: number
  followers?: number
  copiers?: number
  winRate?: number
  maxDrawdown?: number
}

export class GateioFuturesConnector extends BaseConnector {
  readonly platform = 'gateio' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'gateio',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: ['Strategy bot platform', 'Copy trading features', 'May require web scraping'],
  }

  private getHeaders(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.gate.io',
      'Referer': 'https://www.gate.io/strategybot',
    }
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    const periodMap: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' }
    const period = periodMap[window] || '30d'

    try {
      // Attempt to use Gate.io strategy bot API
      const _rawLb = await this.request<{ data?: { list?: GateioLeaderboardEntry[] } }>(
        `https://www.gate.io/api/v1/copy/leaders?page=1&limit=${limit}&period=${period}&sort=roi`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(GateioFuturesLeaderboardResponseSchema, _rawLb, 'gateio-futures/leaderboard')

      const list = data?.data?.list || []
      const traders: TraderSource[] = list.map((item) => ({
        platform: 'gateio' as const,
        market_type: 'futures' as const,
        trader_key: String(item.uid || ''),
        display_name: item.nickname || null,
        profile_url: `https://www.gate.io/strategybot/trader/${item.uid}`,
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
      const _rawProfile = await this.request<{ data?: GateioLeaderboardEntry }>(
        `https://www.gate.io/api/v1/copy/leader/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(GateioFuturesDetailResponseSchema, _rawProfile, 'gateio-futures/profile')

      const info = data?.data
      if (!info) return null

      const profile: TraderProfile = {
        platform: 'gateio',
        market_type: 'futures',
        trader_key: traderKey,
        display_name: info.nickname || null,
        avatar_url: info.avatar || null,
        bio: null,
        tags: ['strategy-bot', 'copy-trading'],
        profile_url: `https://www.gate.io/strategybot/trader/${traderKey}`,
        followers: this.num(info.followers),
        copiers: this.num(info.copiers),
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'gateio',
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
    const periodMap: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' }
    const period = periodMap[window] || '30d'

    try {
      const _rawSnap = await this.request<{ data?: GateioLeaderboardEntry }>(
        `https://www.gate.io/api/v1/copy/leader/${traderKey}?period=${period}`,
        { method: 'GET', headers: this.getHeaders() }
      )
      const data = warnValidate(GateioFuturesDetailResponseSchema, _rawSnap, 'gateio-futures/snapshot')

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
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: null,
        followers: this.num(info.followers),
        copiers: this.num(info.copiers),
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags: QualityFlags = {
        missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count', 'aum'],
        non_standard_fields: {},
        window_native: true,
        notes: ['Gate.io strategy bot platform'],
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
      trader_key: raw.uid,
      display_name: raw.nickname,
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
