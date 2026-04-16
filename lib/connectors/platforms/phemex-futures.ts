/**
 * Phemex Futures Connector
 */

import { BaseConnector } from '../base'
import { warnValidate } from '../schemas'
import { safeNumber } from '../utils'
import {
  PhemexFuturesLeaderboardResponseSchema,
  PhemexFuturesDetailResponseSchema,
} from './schemas'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class PhemexFuturesConnector extends BaseConnector {
  readonly platform = 'phemex' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'phemex',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: ['All 3 windows supported'],
  }

  async discoverLeaderboard(window: Window, limit = 20, offset = 0): Promise<DiscoverResult> {
    const page = Math.floor(offset / limit) + 1
    const _rawLb = await this.request<Record<string, unknown>>(
      `https://api.phemex.com/copy-trading/public/traders?page=${page}&pageSize=${limit}&sortBy=roi&sortOrder=desc&period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(PhemexFuturesLeaderboardResponseSchema, _rawLb, 'phemex-futures/leaderboard')
    const list = data?.data?.rows || []

    const traders: TraderSource[] = (Array.isArray(list) ? list : []).map((item: Record<string, unknown>) => ({
      platform: 'phemex' as const, market_type: 'futures' as const,
      trader_key: String(item.uid || ''), display_name: (item.nickname as string) || null,
      profile_url: `https://phemex.com/copy-trading/trader/${item.uid}`,
      discovered_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      is_active: true, raw: item as Record<string, unknown>,
    }))
    return { traders, total_available: data?.data?.total || null, window, fetched_at: new Date().toISOString() }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const _rawProfile = await this.request<Record<string, unknown>>(
      `https://api.phemex.com/copy-trading/public/trader/${traderKey}/detail`,
      { method: 'GET' }
    )
    const data = warnValidate(PhemexFuturesDetailResponseSchema, _rawProfile, 'phemex-futures/profile')
    const info = data?.data
    if (!info) return null

    const profile: TraderProfile = {
      platform: 'phemex', market_type: 'futures', trader_key: traderKey,
      display_name: (info.nickname as string) || null, avatar_url: (info.avatar as string) || null,
      bio: null, tags: [],
      profile_url: `https://phemex.com/copy-trading/trader/${traderKey}`,
      followers: safeNumber(info.followers), copiers: safeNumber(info.copiers), aum: null,
      updated_at: new Date().toISOString(), last_enriched_at: new Date().toISOString(),
      provenance: { source_platform: 'phemex', acquisition_method: 'api', fetched_at: new Date().toISOString(), source_url: null, scraper_version: '1.0.0' },
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const _rawSnap = await this.request<Record<string, unknown>>(
      `https://api.phemex.com/copy-trading/public/trader/${traderKey}/detail?period=${window}`,
      { method: 'GET' }
    )
    const data = warnValidate(PhemexFuturesDetailResponseSchema, _rawSnap, 'phemex-futures/snapshot')
    const info = data?.data
    if (!info) return null

    const metrics: SnapshotMetrics = {
      roi: safeNumber(info.roi), pnl: safeNumber(info.pnl),
      win_rate: safeNumber(info.winRate), max_drawdown: safeNumber(info.maxDrawdown),
      sharpe_ratio: null, sortino_ratio: null, trades_count: null,
      followers: safeNumber(info.followers), copiers: safeNumber(info.copiers),
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

  /**
   * Normalize raw Phemex leaderboard entry.
   * Raw fields: uid, nickname, avatar, roi, pnl, winRate (decimal 0-1),
   * maxDrawdown (decimal 0-1), followers, copiers.
   */
  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    const rawWr = safeNumber(raw.winRate)
    const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
    const rawMdd = safeNumber(raw.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    return {
      trader_key: raw.uid ?? null,
      display_name: raw.nickname ?? null,
      avatar_url: raw.avatar ?? null,
      roi: safeNumber(raw.roi),
      pnl: safeNumber(raw.pnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: null,
      followers: safeNumber(raw.followers),
      copiers: safeNumber(raw.copiers),
      aum: null,
      sharpe_ratio: null,
      platform_rank: null,
    }
  }

}
