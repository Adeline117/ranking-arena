/**
 * Drift Protocol Perp Connector
 *
 * Fetches trader leaderboard from Drift's public data API.
 *
 * API: GET https://data.api.drift.trade/stats/leaderboard
 * - Public, no auth required
 * - 100/page, up to 500 traders
 * - PnL in USD
 * - ROI estimated from volume (no capital data): pnl / (volume / 10) × 100
 * - Supports date-range filtering for 7D/30D
 */

import { BaseConnector } from '../base'
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

interface DriftTraderEntry {
  authority: string    // Solana base58 address (case-sensitive)
  pnl: number
  volume: number
  rank: number
}

interface DriftResponse {
  data?: { leaderboard: DriftTraderEntry[] } | DriftTraderEntry[]
  result?: DriftTraderEntry[]
}

export class DriftPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'drift'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'drift',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'platform_rank', 'max_drawdown'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'ROI estimated from volume (assumes 10x avg leverage)',
      '500 traders max, sorted by PnL',
    ],
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const pageSize = 100
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []

    // Build date range for 7D/30D
    const now = new Date()
    const days = window === '7d' ? 7 : window === '30d' ? 30 : 0
    const startDate = days > 0
      ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      : undefined
    const endDate = days > 0 ? now.toISOString().split('T')[0] : undefined

    for (let page = 1; page <= maxPages; page++) {
      try {
        let url = `https://data.api.drift.trade/stats/leaderboard?page=${page}&limit=${pageSize}&sort=pnl`
        if (startDate && endDate) {
          url += `&start=${startDate}&end=${endDate}`
        }

        const data = await this.request<DriftResponse>(url)
        // Drift API returns { success, data: { leaderboard: [...] } }
        const rawData = data?.data
        const list = (rawData && !Array.isArray(rawData) && 'leaderboard' in rawData ? rawData.leaderboard : rawData) || data?.result || []
        if (!Array.isArray(list) || !list.length) break

        for (const entry of list) {
          allTraders.push({
            platform: this.platform,
            market_type: this.marketType,
            trader_key: entry.authority,
            display_name: `${entry.authority.slice(0, 4)}...${entry.authority.slice(-4)}`,
            profile_url: `https://app.drift.trade/stats/user/${entry.authority}`,
            discovered_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            is_active: true,
            raw: entry as unknown as Record<string, unknown>,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= limit) break
      } catch (err) {
        if (page === 1) throw err
        break
      }
    }

    return {
      traders: allTraders.slice(0, limit),
      total_available: null,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Fetch daily equity snapshots to compute MDD
    const days = window === '7d' ? 14 : window === '30d' ? 60 : 100
    try {
      const snapshots = await this.request<Array<{
        ts: number
        accountBalance: string
        unrealizedPnl: string
        cumulativeRealizedPnl: string
      }>>(
        `https://data.api.drift.trade/authority/${traderKey}/snapshots/trading?days=${days}`
      )

      if (!Array.isArray(snapshots) || snapshots.length < 2) return null

      // Compute MDD from equity curve (accountBalance + unrealizedPnl)
      let peak = -Infinity
      let maxDD = 0
      for (const s of snapshots) {
        const equity = Number(s.accountBalance || 0) + Number(s.unrealizedPnl || 0)
        if (equity > peak) peak = equity
        if (peak > 0) {
          const dd = ((peak - equity) / peak) * 100
          if (dd > maxDD) maxDD = dd
        }
      }

      // Get latest PnL
      const latest = snapshots[snapshots.length - 1]
      const pnl = Number(latest?.cumulativeRealizedPnl || 0)

      return {
        metrics: {
          roi: null, // ROI comes from leaderboard
          pnl: pnl || null,
          win_rate: null,
          max_drawdown: maxDD > 0.01 ? Math.round(maxDD * 100) / 100 : null,
          sharpe_ratio: null, sortino_ratio: null,
          trades_count: null, followers: null, copiers: null, aum: null,
          platform_rank: null,
          arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
        },
        quality_flags: {
          missing_fields: ['win_rate', 'trades_count'],
          non_standard_fields: { max_drawdown: 'Computed from daily equity snapshots' },
          window_native: true,
          notes: ['MDD computed from peak-to-trough equity curve'],
        },
        fetched_at: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as DriftTraderEntry
    // ROI estimated: pnl / (volume / 10) × 100
    let roi: number | null = null
    if (e.pnl != null && e.volume != null && e.volume > 0) {
      const estimatedCapital = e.volume / 10
      roi = estimatedCapital > 0
        ? Math.max(-100, Math.min(10000, (e.pnl / estimatedCapital) * 100))
        : null
    }

    return {
      trader_key: e.authority,
      display_name: e.authority
        ? `${e.authority.slice(0, 4)}...${e.authority.slice(-4)}`
        : null,
      roi,
      pnl: e.pnl ?? null,
      platform_rank: e.rank ?? null,
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
