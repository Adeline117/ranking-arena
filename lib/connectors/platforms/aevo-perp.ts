/**
 * Aevo Perp Connector
 *
 * Fetches leaderboard from Aevo's public API.
 *
 * API: GET https://api.aevo.xyz/leaderboard?limit=500
 * - Public, no auth required
 * - Single call returns all periods (weekly/monthly/all_time)
 * - ROI estimated from PnL / (totalVolume / 10)
 * - No win_rate or MDD available
 */

import { BaseConnector } from '../base'
import { safeNumber } from '../utils'
import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  PlatformCapabilities,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  TraderSource,
} from '../../types/leaderboard'

interface AevoLeaderboardEntry {
  username: string
  pnl: number | string   // Numeric or string
  options_volume?: number | string
  perp_volume?: number | string
  totalVolume?: string   // Legacy field
  ranking: number
}

interface AevoResponse {
  // New format (2026+): nested under 'leaderboard' key
  leaderboard?: {
    daily?: AevoLeaderboardEntry[]
    weekly?: AevoLeaderboardEntry[]
    monthly?: AevoLeaderboardEntry[]
    all_time?: AevoLeaderboardEntry[]
  }
  // Legacy format: top-level keys
  weekly?: AevoLeaderboardEntry[]
  monthly?: AevoLeaderboardEntry[]
  all_time?: AevoLeaderboardEntry[]
}

export class AevoPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'aevo'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'aevo',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'platform_rank'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'Single call returns all periods',
      'ROI estimated from volume (assumes 10x avg leverage)',
    ],
  }

  private mapWindowToKey(window: Window): 'weekly' | 'monthly' | 'all_time' {
    const m: Record<Window, 'weekly' | 'monthly' | 'all_time'> = {
      '7d': 'weekly',
      '30d': 'monthly',
      '90d': 'all_time',
    }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const data = await this.request<AevoResponse>(
      'https://api.aevo.xyz/leaderboard?limit=500'
    )

    const key = this.mapWindowToKey(window)
    // Support both new format (nested under 'leaderboard') and legacy (top-level)
    const entries = data?.leaderboard?.[key] || data?.[key] || []

    const traders: TraderSource[] = entries.slice(0, limit).map((entry: AevoLeaderboardEntry) => ({
      platform: this.platform,
      market_type: this.marketType,
      trader_key: (entry.username || '').toLowerCase(),
      display_name: entry.username || null,
      profile_url: `https://app.aevo.xyz/portfolio/${entry.username}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: { ...entry, _window_key: key } as unknown as Record<string, unknown>,
    }))

    return {
      traders,
      total_available: entries.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw Aevo leaderboard entry.
   * ROI estimated from PnL / (volume / 10). Low-volume traders get roi=null
   * (not a hardcoded value) to avoid fake Arena Scores.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as AevoLeaderboardEntry
    const pnl = safeNumber(e.pnl)
    // Support new format (options_volume + perp_volume) and legacy (totalVolume)
    const optVol = safeNumber(e.options_volume) ?? 0
    const perpVol = safeNumber(e.perp_volume) ?? 0
    const volume = (optVol + perpVol) || safeNumber(e.totalVolume)

    // Estimate ROI: pnl / (volume / 10) × 100, assumes 10x avg leverage
    // Low-volume traders (estimatedCapital <= 100) get null ROI — not fake data
    let roi: number | null = null
    if (pnl != null && volume != null && volume > 0) {
      const estimatedCapital = volume / 10
      if (estimatedCapital > 100) {
        roi = Math.max(-100, Math.min(10000, (pnl / estimatedCapital) * 100))
      }
      // else: roi stays null — insufficient volume to estimate ROI reliably
    }

    return {
      trader_key: (e.username || '').toLowerCase(),
      display_name: e.username || null,
      roi,
      pnl,
      platform_rank: e.ranking ?? null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: null,
    }
  }
}
