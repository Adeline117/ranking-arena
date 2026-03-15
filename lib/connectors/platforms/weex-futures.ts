/**
 * WEEX Futures Connector
 * Note: WEEX does NOT support 90d window.
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import {
  WeexFuturesLeaderboardResponseSchema,
  WeexFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class WeexFuturesConnector extends BaseConnector {
  readonly platform = 'weex' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'weex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],  // No 90d
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: ['No 90d window', 'Aggressive CF'],
  }

  async discoverLeaderboard(window: Window, limit = 20, offset = 0): Promise<DiscoverResult> {
    // WEEX API (weex.com/api/) returns 521 since ~2026-03.
    // Real API is on janapw.com with dynamic auth headers (x-sig, sidecar, vs).
    // Strategy 1: VPS Playwright scraper with waitForResponse to capture the browser call.
    const allTraders: TraderSource[] = []

    try {
      const vpsData = await this.fetchViaVPS<{ traders?: Array<Record<string, unknown>>; total?: number }>(
        '/weex/leaderboard-v2',
        { pageSize: String(limit) },
        90000
      )
      if (vpsData?.traders?.length) {
        for (const item of vpsData.traders) {
          const uid = String(item.traderUserId || '')
          if (!uid) continue
          allTraders.push({
            platform: 'weex' as const, market_type: 'futures' as const,
            trader_key: uid,
            display_name: (item.traderNickName as string) || null,
            profile_url: `https://www.weex.com/copy-trading/trader/${uid}`,
            discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
            is_active: true, raw: item,
          })
        }
      }
    } catch {
      // VPS scraper failed — WEEX is unavailable
    }

    return { traders: allTraders.slice(0, limit), total_available: allTraders.length, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://www.weex.com/api/v1/copy-trade/public/trader/${traderKey}/info`,
      { method: 'GET' }
    )
    const data = warnValidate(WeexFuturesDetailResponseSchema, _rawProfile, 'weex-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'weex', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null, avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://www.weex.com/copy-trading/trader/${traderKey}`,
      followers: this.num(info.followers), copiers: this.num(info.copiers), aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'weex', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    if (window === '90d') {
      return {
        metrics: { roi: null, pnl: null, win_rate: null, max_drawdown: null, sharpe_ratio: null, sortino_ratio: null, trades_count: null, followers: null, copiers: null, aum: null, platform_rank: null, arena_score: null, return_score: null, drawdown_score: null, stability_score: null },
        quality_flags: { missing_fields: ['roi', 'pnl'], non_standard_fields: {}, window_native: false, notes: ['WEEX does not provide 90-day window'] },
        fetched_at: new Date().toISOString(),
      }
    }
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://www.weex.com/api/v1/copy-trade/public/trader/${traderKey}/info?period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(WeexFuturesDetailResponseSchema, _rawSnap, 'weex-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: this.num(info.roi), pnl: this.num(info.pnl),
      win_rate: this.num(info.winRate), max_drawdown: this.num(info.maxDrawdown),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: this.num(info.followers), copiers: this.num(info.copiers),
      aum: null, platform_rank: null,
      arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
    }
    const quality_flags: QualityFlags = {
      missing_fields: ['sharpe_ratio', 'sortino_ratio', 'trades_count'],
      non_standard_fields: {}, window_native: true, notes: [],
    }
    return { metrics, quality_flags, fetched_at: new Date().toISOString() }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return { trader_key: raw.uid, roi: this.num(raw.roi), pnl: this.num(raw.pnl) }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val); return isNaN(n) ? null : n
  }
}
