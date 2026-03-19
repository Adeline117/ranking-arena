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
  SnapshotMetrics,
  QualityFlags,
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
  totalPnlUsd: number | string  // Raw units (÷1e6 for USD), may be string from API
  totalVolumeUsd?: number | string
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
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'trades_count'],
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
    // Capped to avoid Vercel 504: 90D uses 6 weeks (enough signal, avoids >180 serial requests)
    return window === '7d' ? 1 : window === '30d' ? 4 : 6
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
    const traderMap = new Map<string, { pnl: number; volume: number; wins: number; losses: number; trades: number }>()

    // Generate week list
    const weeks: Array<{ year: number; week: number }> = []
    for (let i = 0; i < numWeeks; i++) {
      const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000)
      weeks.push(this.getISOWeek(d))
    }

    // Fetch all markets × weeks — markets fetched in parallel per week to reduce total time.
    // Sequential over weeks to respect rate limits; parallel across 3 markets is safe (public API).
    for (const { year, week } of weeks) {
      const marketResults = await Promise.allSettled(
        MARKETS.map(async (mint) => {
          const url = `https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&year=${year}&week=${week}`
          return this.request<Record<string, unknown> | JupiterTraderEntry[]>(url)
        })
      )

      for (const result of marketResults) {
        if (result.status === 'rejected') continue // Skip failed week/market combos
        const rawData = result.value
        // API returns { topTradersByPnl: [...] } or direct array
        const data: JupiterTraderEntry[] = Array.isArray(rawData)
          ? rawData
          : Array.isArray((rawData as Record<string, unknown>)?.topTradersByPnl)
            ? (rawData as Record<string, unknown>).topTradersByPnl as JupiterTraderEntry[]
            : []
        if (data.length === 0) continue

        for (const entry of data) {
          if (!entry.owner) continue
          const existing = traderMap.get(entry.owner) || { pnl: 0, volume: 0, wins: 0, losses: 0, trades: 0 }
          const weekPnl = Number(entry.totalPnlUsd || 0) / 1e6
          existing.pnl += weekPnl
          existing.volume += Number(entry.totalVolumeUsd || entry.totalVolume || 0) / 1e6
          existing.trades += entry.totalTrades || 0
          // Count profitable market-weeks as wins
          if (weekPnl > 0) existing.wins++
          else if (weekPnl < 0) existing.losses++
          traderMap.set(entry.owner, existing)
        }
      }
      // Brief delay between weeks to avoid rate limiting
      await this.sleep(200)
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
      raw: {
        owner, pnl: data.pnl, volume: data.volume,
        wins: data.wins, losses: data.losses, trades: data.trades,
        _computed_win_rate: (data.wins + data.losses) > 0 ? (data.wins / (data.wins + data.losses)) * 100 : null,
      } as Record<string, unknown>,
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

  async fetchTraderSnapshot(traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    try {
      // Jupiter has full position history with PnL — compute WR and MDD
      const positions = await this.request<Array<{
        pnlUsd?: number | string
        status?: string
        side?: string
        collateralUsd?: number | string
        sizeUsd?: number | string
      }>>(
        `https://perps-api.jup.ag/v1/positions?walletAddress=${traderKey}&includeClosedPositions=true`
      )

      if (!Array.isArray(positions) || positions.length === 0) return null

      const closedPositions = positions.filter(p => p.status === 'closed' || p.pnlUsd != null)
      if (closedPositions.length < 2) return null

      // Win rate from closed positions
      const wins = closedPositions.filter(p => Number(p.pnlUsd || 0) > 0).length
      const losses = closedPositions.filter(p => Number(p.pnlUsd || 0) < 0).length
      const total = wins + losses
      const winRate = total > 0 ? (wins / total) * 100 : null

      // MDD from cumulative PnL curve
      let cumPnl = 0
      let peak = 0
      let maxDD = 0
      for (const p of closedPositions) {
        cumPnl += Number(p.pnlUsd || 0)
        if (cumPnl > peak) peak = cumPnl
        if (peak > 0) {
          const dd = ((peak - cumPnl) / peak) * 100
          if (dd > maxDD) maxDD = dd
        }
      }

      return {
        metrics: {
          roi: null, // ROI comes from leaderboard
          pnl: cumPnl || null,
          win_rate: winRate != null ? Math.round(winRate * 100) / 100 : null,
          max_drawdown: maxDD > 0.01 && maxDD < 200 ? Math.round(maxDD * 100) / 100 : null,
          trades_count: total,
          sharpe_ratio: null, sortino_ratio: null,
          followers: null, copiers: null, aum: null,
          platform_rank: null,
          arena_score: null, return_score: null, drawdown_score: null, stability_score: null,
        },
        quality_flags: {
          missing_fields: ['followers', 'copiers'],
          non_standard_fields: {
            win_rate: 'Computed from closed positions PnL',
            max_drawdown: 'Computed from cumulative PnL curve',
          },
          window_native: false,
          notes: ['WR/MDD from /v1/positions?includeClosedPositions=true'],
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
    const e = raw as { owner: string; pnl: number; volume: number; wins?: number; losses?: number; trades?: number; _computed_win_rate?: number | null }
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
      win_rate: e._computed_win_rate ?? null,
      max_drawdown: null,
      followers: null,
      trades_count: e.trades ?? null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: null,
      platform_rank: null,
    }
  }
}
