/**
 * Copin.io On-Chain Perpetual DEX Aggregator Connector
 *
 * Aggregates trader data from 51+ perpetual DEX protocols.
 * Uses the position/filter endpoint (no auth needed) to get closed positions,
 * then aggregates top traders by PnL.
 *
 * Key API: POST /PROTOCOL/position/filter (NOT /public/ — that returns empty)
 * Returns individual closed positions with account, pnl, roi, pair, etc.
 * We aggregate these into per-trader stats.
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

const BASE = 'https://api.copin.io'

// Top protocols — highest volume DEX perps
const PROTOCOLS = [
  'HYPERLIQUID',
  'GMX_V2',
  'GNS',
  'DYDX',
  'KWENTA',
  'SYNTHETIX_V3',
] as const

interface CopinPosition {
  account: string
  pnl: number
  roi: number
  isWin: boolean
  isLiquidate: boolean
  pair: string
  leverage: number
  size: number
  durationInSecond: number
  closeBlockTime: string
  protocol: string
}

interface TraderAgg {
  account: string
  protocol: string
  totalPnl: number
  totalTrades: number
  wins: number
  losses: number
  liquidations: number
  totalVolume: number
  avgRoi: number
  rois: number[]
  maxDrawdown: number
}

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
      'Uses /PROTOCOL/position/filter (not /public/ which returns empty)',
      'Aggregates individual positions into per-trader stats',
      'trader_key = protocol:walletAddress',
    ],
  }

  async discoverLeaderboard(window: Window, limit = 200, _offset = 0): Promise<DiscoverResult> {
    const daysMap: Record<Window, number> = { '7d': 7, '30d': 30, '90d': 60 }
    const cutoff = new Date(Date.now() - daysMap[window] * 86400000).toISOString()

    const allTraders: TraderSource[] = []

    // Fetch top traders from each protocol
    for (let i = 0; i < PROTOCOLS.length; i += 2) {
      const batch = PROTOCOLS.slice(i, i + 2)
      const results = await Promise.allSettled(
        batch.map((protocol) => this.fetchTopTraders(protocol, cutoff, 200))
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allTraders.push(...result.value)
        }
      }

      if (i + 2 < PROTOCOLS.length) await this.sleep(500)
    }

    // Deduplicate by wallet address (keep highest PnL)
    const byKey = new Map<string, TraderSource>()
    for (const t of allTraders) {
      const existing = byKey.get(t.trader_key)
      if (!existing || (this.num(t.raw?.totalPnl) ?? 0) > (this.num(existing.raw?.totalPnl) ?? 0)) {
        byKey.set(t.trader_key, t)
      }
    }

    const deduped = Array.from(byKey.values())
    deduped.sort((a, b) => (this.num(b.raw?.totalPnl) ?? 0) - (this.num(a.raw?.totalPnl) ?? 0))

    return {
      traders: deduped.slice(0, limit),
      total_available: deduped.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  private async fetchTopTraders(protocol: string, cutoff: string, _positionLimit: number): Promise<TraderSource[]> {
    // Fetch recent closed positions sorted by PnL (top profitable trades)
    // Use 500 positions to catch enough unique traders
    const body = {
      pagination: { limit: 500, offset: 0 },
      queries: [
        { fieldName: 'status', value: 'CLOSE' },
      ],
      sortBy: 'pnl',
      sortType: 'desc',
    }

    const raw = await this.request<{ data?: CopinPosition[]; meta?: Record<string, unknown> }>(
      `${BASE}/${protocol}/position/filter`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    )

    const positions = raw?.data
    if (!Array.isArray(positions) || positions.length === 0) return []

    // Aggregate by trader
    const traders = new Map<string, TraderAgg>()

    for (const pos of positions) {
      if (!pos.account || new Date(pos.closeBlockTime) < new Date(cutoff)) continue

      const key = pos.account.toLowerCase()
      let agg = traders.get(key)
      if (!agg) {
        agg = {
          account: pos.account,
          protocol,
          totalPnl: 0,
          totalTrades: 0,
          wins: 0,
          losses: 0,
          liquidations: 0,
          totalVolume: 0,
          avgRoi: 0,
          rois: [],
          maxDrawdown: 0,
        }
        traders.set(key, agg)
      }

      agg.totalPnl += pos.pnl ?? 0
      agg.totalTrades++
      if (pos.isWin) agg.wins++
      else agg.losses++
      if (pos.isLiquidate) agg.liquidations++
      agg.totalVolume += Math.abs(pos.size ?? 0)
      if (pos.roi != null) agg.rois.push(pos.roi)
    }

    // Convert to TraderSource[]
    return Array.from(traders.values())
      .filter((t) => t.totalTrades >= 1) // Any trader with at least 1 closed position
      .sort((a, b) => b.totalPnl - a.totalPnl)
      .slice(0, 200)
      .map((agg) => {
        const avgRoi = agg.rois.length > 0
          ? agg.rois.reduce((s, r) => s + r, 0) / agg.rois.length * 100
          : null
        // win_rate is NOT computed here because positions are fetched sorted by
        // PnL desc, which biases the sample toward winning trades and produces
        // artificially high (often 100%) win rates. Accurate win_rate comes
        // from the Copin leaderboard stats during the enrichment phase.
        const winRate = null

        return {
          platform: 'copin' as const,
          market_type: 'perp' as const,
          trader_key: `${protocol.toLowerCase()}:${agg.account}`,
          display_name: null,
          profile_url: `https://app.copin.io/${protocol}/trader/${agg.account}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: {
            account: agg.account,
            _protocol: protocol,
            totalPnl: agg.totalPnl,
            totalTrade: agg.totalTrades,
            totalWin: agg.wins,
            totalLose: agg.losses,
            totalLiquidation: agg.liquidations,
            totalVolume: agg.totalVolume,
            avgRoi,
            winRate,
          },
        }
      })
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const [protocol, address] = traderKey.includes(':') ? traderKey.split(':') : ['hyperliquid', traderKey]

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
    const [protocol, address] = traderKey.includes(':') ? traderKey.split(':') : ['hyperliquid', traderKey]
    const daysMap: Record<Window, number> = { '7d': 7, '30d': 30, '90d': 60 }
    const cutoff = new Date(Date.now() - daysMap[window] * 86400000).toISOString()

    try {
      // Fetch this trader's recent closed positions
      const body = {
        pagination: { limit: 500, offset: 0 },
        queries: [
          { fieldName: 'status', value: 'CLOSE' },
          { fieldName: 'account', value: address },
        ],
        sortBy: 'closeBlockTime',
        sortType: 'desc',
      }

      const raw = await this.request<{ data?: CopinPosition[] }>(
        `${BASE}/${protocol.toUpperCase()}/position/filter`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )

      const positions = (raw?.data || []).filter(
        (p) => new Date(p.closeBlockTime) >= new Date(cutoff)
      )

      if (positions.length === 0) return null

      // Aggregate stats
      let totalPnl = 0
      let wins = 0
      let losses = 0
      let _totalVolume = 0
      const rois: number[] = []

      for (const pos of positions) {
        totalPnl += pos.pnl ?? 0
        if (pos.isWin) wins++
        else losses++
        _totalVolume += Math.abs(pos.size ?? 0)
        if (pos.roi != null) rois.push(pos.roi)
      }

      const totalTrades = wins + losses
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null
      const avgRoi = rois.length > 0 ? rois.reduce((s, r) => s + r, 0) / rois.length * 100 : null

      const metrics: SnapshotMetrics = {
        roi: avgRoi,
        pnl: totalPnl,
        win_rate: winRate,
        max_drawdown: null,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: totalTrades,
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
      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch (err) {
      this.logger.debug('Copin snapshot fetch failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.account ? `${String(raw._protocol || 'hyperliquid').toLowerCase()}:${raw.account}` : null,
      display_name: null,
      avatar_url: null,
      roi: this.num(raw.avgRoi),
      pnl: this.num(raw.totalPnl) ?? this.num(raw.pnl),
      win_rate: this.num(raw.winRate),
      max_drawdown: null,
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
