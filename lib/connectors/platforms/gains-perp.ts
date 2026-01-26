/**
 * Gains Network (gTrade) Perpetual Connector
 *
 * Uses Gains Network's REST API and subgraph for trader stats.
 *
 * Key notes:
 * - trader_key is wallet address on Arbitrum
 * - Has REST API: /open-trades, /personal-trading-history-table/<address>
 * - Also has GraphQL subgraph on Arbitrum
 * - No followers/copiers (DEX - no copy trading)
 */

import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

interface GainsTrade {
  trader?: string
  pairIndex?: number
  index?: number
  leverage?: number
  collateralAmount?: number
  openPrice?: number
  tp?: number
  sl?: number
  timestamp?: number
}

interface GainsTradeHistory {
  address?: string
  pnl?: number
  pnlPercent?: number
  action?: string
  pair?: string
  leverage?: number
  collateral?: number
  date?: string
}

export class GainsPerpConnector extends BaseConnector {
  readonly platform = 'gains' as const
  readonly marketType = 'perp' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'gains' as any,
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'trades_count'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2, // REST API + subgraph available
    rate_limit: { rpm: 30, concurrency: 5 },
    notes: ['Arbitrum DEX', 'gTrade platform', 'REST API available', 'No copy trading'],
  }

  private readonly API_BASE = 'https://backend-arbitrum.gains.trade'
  private readonly SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/gainsnetwork-org/gtrade-stats-arbitrum'

  private getHeaders(): Record<string, string> {
    return {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    try {
      // Get open trades to discover active traders
      const data = await this.request<GainsTrade[]>(
        `${this.API_BASE}/open-trades`,
        { method: 'GET', headers: this.getHeaders() }
      )

      // Extract unique trader addresses
      const traderSet = new Set<string>()
      const traders: TraderSource[] = []

      for (const trade of data || []) {
        if (trade.trader && !traderSet.has(trade.trader.toLowerCase())) {
          traderSet.add(trade.trader.toLowerCase())
          traders.push({
            platform: 'gains' as any,
            market_type: 'perp' as const,
            trader_key: trade.trader.toLowerCase(),
            display_name: `${trade.trader.slice(0, 6)}...${trade.trader.slice(-4)}`,
            profile_url: `https://gains.trade/trader/${trade.trader}`,
            discovered_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            is_active: true,
            raw: trade as unknown as Record<string, unknown>,
          })

          if (traders.length >= limit) break
        }
      }

      return { traders, total_available: traders.length, window, fetched_at: new Date().toISOString() }
    } catch {
      return { traders: [], total_available: 0, window, fetched_at: new Date().toISOString() }
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    try {
      const profile: TraderProfile = {
        platform: 'gains' as any,
        market_type: 'perp',
        trader_key: traderKey.toLowerCase(),
        display_name: `${traderKey.slice(0, 6)}...${traderKey.slice(-4)}`,
        avatar_url: null,
        bio: null,
        tags: ['arbitrum', 'perpetual', 'gtrade'],
        profile_url: `https://gains.trade/trader/${traderKey}`,
        followers: null,
        copiers: null,
        aum: null,
        updated_at: new Date().toISOString(),
        last_enriched_at: new Date().toISOString(),
        provenance: {
          source_platform: 'gains',
          acquisition_method: 'api',
          fetched_at: new Date().toISOString(),
          source_url: this.API_BASE,
          scraper_version: '1.0.0',
        },
      }
      return { profile, fetched_at: new Date().toISOString() }
    } catch {
      return null
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    try {
      // Get trader's open positions
      const openTrades = await this.request<GainsTrade[]>(
        `${this.API_BASE}/open-trades/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )

      // Get trading history
      const history = await this.request<GainsTradeHistory[]>(
        `${this.API_BASE}/personal-trading-history-table/${traderKey}`,
        { method: 'GET', headers: this.getHeaders() }
      )

      // Calculate stats from history
      let totalPnl = 0
      let totalTrades = 0
      const now = new Date()
      const windowDays = window === '7d' ? 7 : window === '30d' ? 30 : 90

      for (const trade of history || []) {
        if (trade.date) {
          const tradeDate = new Date(trade.date)
          const daysDiff = (now.getTime() - tradeDate.getTime()) / (1000 * 60 * 60 * 24)
          if (daysDiff <= windowDays) {
            totalPnl += trade.pnl || 0
            totalTrades++
          }
        }
      }

      const metrics: SnapshotMetrics = {
        roi: null, // Would need initial capital to calculate
        pnl: totalPnl || null,
        win_rate: null,
        max_drawdown: null,
        sharpe_ratio: null,
        sortino_ratio: null,
        trades_count: totalTrades || null,
        followers: null,
        copiers: null,
        aum: null,
        platform_rank: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
      }

      const quality_flags: QualityFlags = {
        missing_fields: ['roi', 'win_rate', 'max_drawdown', 'sharpe_ratio', 'followers', 'copiers', 'aum'],
        non_standard_fields: { open_positions: String(openTrades?.length || 0) },
        window_native: true,
        notes: ['Gains Network Arbitrum DEX', `${openTrades?.length || 0} open positions`],
      }

      return { metrics, quality_flags, fetched_at: new Date().toISOString() }
    } catch {
      return {
        metrics: this.emptyMetrics(),
        quality_flags: { missing_fields: ['all'], non_standard_fields: {}, window_native: false, notes: ['API error or trader not found'] },
        fetched_at: new Date().toISOString(),
      }
    }
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    return {
      trader_key: raw.trader || raw.address,
      pnl: this.num(raw.pnl),
      trades_count: this.num(raw.totalTrades),
    }
  }

  protected num(val: unknown): number | null {
    if (val === null || val === undefined) return null
    const n = Number(val)
    return isNaN(n) ? null : n
  }
}
