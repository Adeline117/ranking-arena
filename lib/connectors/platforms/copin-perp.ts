/**
 * Copin.io On-Chain Perpetual DEX Aggregator Connector
 *
 * Aggregates trader data from 51+ perpetual DEX protocols.
 * Uses the public statistics filter endpoint (no API key needed).
 * Rich data: PnL, ROI, win rate, max drawdown, leverage, duration, etc.
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const BASE = 'https://api.copin.io'

// Top protocols to aggregate from — highest volume DEX perps
const PROTOCOLS = [
  'HYPERLIQUID',
  'GMX_V2',
  'GNS_V8',
  'DYDX',
  'KWENTA',
  'SYNTHETIX_V3',
  'BSX_BASE',
  'VERTEX_ARB',
  'KILOEX_OPBNB',
  'POLYNOMIAL',
] as const

export class CopinPerpConnector extends BaseConnector {
  readonly platform = 'copin' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'copin',
    market_types: ['perp'],
    native_windows: ['7d', '30d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'trades_count'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 2 },
    notes: [
      'Public filter endpoint returns empty — API key likely required',
      'Aggregates 51+ perp DEX protocols',
      'trader_key = protocol:walletAddress',
      'No 90d window (max D60)',
      'TODO: obtain Copin API key or scrape explorer page',
    ],
  }

  async discoverLeaderboard(window: Window, limit = 2000, _offset = 0): Promise<DiscoverResult> {
    const periodMap: Record<Window, string> = {
      '7d': 'D7',
      '30d': 'D30',
      '90d': 'D60', // Copin max is D60
    }

    const allTraders: TraderSource[] = []

    // Fetch from top protocols in parallel (2 at a time)
    for (let i = 0; i < PROTOCOLS.length; i += 2) {
      const batch = PROTOCOLS.slice(i, i + 2)
      const results = await Promise.allSettled(
        batch.map((protocol) => this.fetchProtocolTraders(protocol, periodMap[window], limit))
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allTraders.push(...result.value)
        }
      }

      if (i + 2 < PROTOCOLS.length) {
        await this.sleep(500)
      }
    }

    // Deduplicate by wallet address (trader can appear on multiple protocols)
    const seen = new Set<string>()
    const deduped = allTraders.filter((t) => {
      if (seen.has(t.trader_key)) return false
      seen.add(t.trader_key)
      return true
    })

    // Sort by PnL descending
    deduped.sort((a, b) => {
      const pnlA = this.num(a.raw?.pnl) ?? 0
      const pnlB = this.num(b.raw?.pnl) ?? 0
      return pnlB - pnlA
    })

    return {
      traders: deduped.slice(0, limit * PROTOCOLS.length),
      total_available: deduped.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  private async fetchProtocolTraders(protocol: string, period: string, limit: number): Promise<TraderSource[]> {
    const body = {
      pagination: { limit, offset: 0 },
      queries: [{ fieldName: 'type', value: period }],
      ranges: [
        { fieldName: 'pnl', gte: 100 },
        { fieldName: 'totalTrade', gte: 5 },
      ],
      sortBy: 'pnl',
      sortType: 'desc',
    }

    const raw = await this.request<Record<string, unknown>>(
      `${BASE}/public/${protocol}/position/statistic/filter`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    const data = (raw?.data ?? raw) as Record<string, unknown>[]
    if (!Array.isArray(data)) return []

    return data.map((item) => {
      const account = String(item.account || '')
      return {
        platform: 'copin' as const,
        market_type: 'perp' as const,
        trader_key: `${protocol.toLowerCase()}:${account}`,
        display_name: null,
        profile_url: `https://app.copin.io/${protocol}/trader/${account}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: { ...item, _protocol: protocol },
      }
    })
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // traderKey format: protocol:walletAddress
    const [protocol, address] = traderKey.includes(':') ? traderKey.split(':') : ['HYPERLIQUID', traderKey]

    const profile: TraderProfile = {
      platform: 'copin',
      market_type: 'perp',
      trader_key: traderKey,
      display_name: null,
      avatar_url: null,
      bio: null,
      tags: ['on-chain', 'perp-dex', protocol.toLowerCase()],
      profile_url: `https://app.copin.io/${protocol.toUpperCase()}/trader/${address}`,
      followers: null,
      copiers: null,
      aum: null,
      updated_at: new Date().toISOString(),
      last_enriched_at: null,
      provenance: this.buildProvenance(null),
    }
    return { profile, fetched_at: new Date().toISOString() }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    const [protocol, address] = traderKey.includes(':') ? traderKey.split(':') : ['HYPERLIQUID', traderKey]
    const periodMap: Record<Window, string> = {
      '7d': 'D7',
      '30d': 'D30',
      '90d': 'D60',
    }

    const body = {
      pagination: { limit: 1, offset: 0 },
      queries: [
        { fieldName: 'type', value: periodMap[window] },
        { fieldName: 'account', value: address },
      ],
      sortBy: 'pnl',
      sortType: 'desc',
    }

    try {
      const raw = await this.request<Record<string, unknown>>(
        `${BASE}/public/${protocol.toUpperCase()}/position/statistic/filter`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )

      const data = (raw?.data ?? raw) as Record<string, unknown>[]
      if (!Array.isArray(data) || data.length === 0) return null

      const item = data[0]
      const totalWin = this.num(item.totalWin) ?? 0
      const totalLose = this.num(item.totalLose) ?? 0
      const totalTrades = totalWin + totalLose
      const winRate = totalTrades > 0 ? (totalWin / totalTrades) * 100 : null

      const metrics: SnapshotMetrics = {
        roi: this.num(item.avgRoi) ?? this.num(item.realisedAvgRoi),
        pnl: this.num(item.pnl) ?? this.num(item.realisedPnl),
        win_rate: winRate,
        max_drawdown: this.num(item.maxDrawdown) != null ? Math.abs(this.num(item.maxDrawdown)!) : null,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: this.num(item.totalTrade),
        followers: null,
        copiers: null,
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags = this.buildQualityFlags(metrics, window, window !== '90d')
      if (window === '90d') {
        quality_flags.notes.push('Using D60 period as proxy for 90d')
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
    const totalWin = this.num(raw.totalWin) ?? 0
    const totalLose = this.num(raw.totalLose) ?? 0
    const totalTrades = totalWin + totalLose
    const winRate = totalTrades > 0 ? (totalWin / totalTrades) * 100 : null

    const rawMdd = this.num(raw.maxDrawdown ?? raw.realisedMaxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd) : null

    return {
      trader_key: raw.account ? `${String(raw._protocol || 'HYPERLIQUID').toLowerCase()}:${raw.account}` : null,
      display_name: null,
      avatar_url: null,
      roi: this.num(raw.avgRoi) ?? this.num(raw.realisedAvgRoi),
      pnl: this.num(raw.pnl) ?? this.num(raw.realisedPnl),
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      sharpe_ratio: null,
      trades_count: this.num(raw.totalTrade),
      followers: null,
      copiers: null,
      aum: null,
      platform_rank: null,
    }
  }

  private num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return !Number.isFinite(n) ? null : n
  }
}
