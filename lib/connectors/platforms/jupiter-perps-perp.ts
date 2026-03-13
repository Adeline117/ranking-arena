/**
 * Jupiter Perps Connector
 *
 * Fetches top traders from Jupiter's perps API using weekly data.
 *
 * API: GET https://perps-api.jup.ag/v1/top-traders
 * - Public, no auth required
 * - Week-based: queries multiple weeks for 30D/90D
 * - PnL in raw units (÷1e6 for USD)
 * - ROI estimated: pnl / (volume / 5) × 100 (assumes 5x avg leverage)
 * - Queries SOL, ETH, BTC markets in parallel
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

// Jupiter market mints
const MARKETS = [
  'So11111111111111111111111111111111111111112',   // SOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // BTC
]

interface JupiterTraderEntry {
  owner: string
  totalPnlUsd: number    // Raw units (÷1e6 for USD)
  totalVolume?: number
  totalTrades?: number
}

export class JupiterPerpsPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'jupiter_perps'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'jupiter_perps',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'Week-based aggregation: 1/4/13 weeks for 7D/30D/90D',
      'ROI estimated from volume (assumes 5x avg leverage)',
      'Multi-market: SOL + ETH + BTC',
    ],
  }

  private getWeeksForWindow(window: Window): number {
    return window === '7d' ? 1 : window === '30d' ? 4 : 13
  }

  private getISOWeek(date: Date): { year: number; week: number } {
    const d = new Date(date.getTime())
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
    return { year: d.getUTCFullYear(), week: weekNo }
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const numWeeks = this.getWeeksForWindow(window)
    const now = new Date()
    const traderMap = new Map<string, { pnl: number; volume: number }>()

    // Generate week list
    const weeks: Array<{ year: number; week: number }> = []
    for (let i = 0; i < numWeeks; i++) {
      const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000)
      weeks.push(this.getISOWeek(d))
    }

    // Fetch all markets × weeks
    for (const { year, week } of weeks) {
      for (const mint of MARKETS) {
        try {
          const url = `https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&year=${year}&week=${week}`
          const data = await this.request<JupiterTraderEntry[]>(url, { timeout: 10000 })

          if (!Array.isArray(data)) continue

          for (const entry of data) {
            if (!entry.owner) continue
            const existing = traderMap.get(entry.owner) || { pnl: 0, volume: 0 }
            existing.pnl += (entry.totalPnlUsd || 0) / 1e6
            existing.volume += (entry.totalVolume || 0) / 1e6
            traderMap.set(entry.owner, existing)
          }
        } catch {
          // Skip failed week/market combos
        }
      }
      // Brief delay between weeks
      await this.sleep(100)
    }

    // Convert to TraderSource, sorted by PnL
    const sorted = Array.from(traderMap.entries())
      .sort(([, a], [, b]) => b.pnl - a.pnl)
      .slice(0, limit)

    const traders: TraderSource[] = sorted.map(([owner, data]) => ({
      platform: this.platform,
      market_type: this.marketType,
      trader_key: owner,
      display_name: `${owner.slice(0, 4)}...${owner.slice(-4)}`,
      profile_url: `https://www.jup.ag/perps/${owner}`,
      discovered_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_active: true,
      raw: { owner, pnl: data.pnl, volume: data.volume } as Record<string, unknown>,
    }))

    return {
      traders,
      total_available: traderMap.size,
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

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as { owner: string; pnl: number; volume: number }
    // ROI estimated: pnl / (volume / 5) × 100
    let roi: number | null = null
    if (e.pnl != null && e.volume != null && e.volume > 0) {
      const estimatedCapital = e.volume / 5
      if (estimatedCapital > 0) {
        roi = Math.max(-100, Math.min(10000, (e.pnl / estimatedCapital) * 100))
      }
    }

    return {
      trader_key: e.owner,
      display_name: e.owner
        ? `${e.owner.slice(0, 4)}...${e.owner.slice(-4)}`
        : null,
      roi,
      pnl: e.pnl ?? null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: null,
      platform_rank: null,
    }
  }
}
