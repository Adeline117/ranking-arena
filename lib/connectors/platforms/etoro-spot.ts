/**
 * eToro Spot Connector
 *
 * Fetches copy-trading leaderboard data from eToro's public rankings API.
 * Filters to crypto-only traders (excludes Stocks, ETFs, Currencies, etc.)
 *
 * API: https://www.etoro.com/sapi/rankings/rankings/
 * - Public, no auth required
 * - Pagination: 100/page, up to 2000 traders
 * - ROI already in percentage form (-4.22 = -4.22%)
 * - PnL estimated from AUM × Gain
 * - MDD via PeakToValley (negative → Math.abs)
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

// Non-crypto asset classes to filter out
const EXCLUDED_ASSET_CLASSES = new Set([
  'Stocks', 'ETFs', 'Currencies', 'Commodities', 'Indices',
])

interface EtoroTraderEntry {
  CustomerId: number
  UserName: string
  HasAvatar: boolean
  Gain: number          // ROI in percentage
  WinRatio: number      // Already percentage (0-100)
  PeakToValley: number  // Negative MDD (e.g. -8.43)
  Copiers: number
  AUMValue: number
  Trades?: number
  TopTradedAssetClassName: string
  RiskScore: number
  DailyDD: number
  WeeklyDD: number
}

interface EtoroResponse {
  Items: EtoroTraderEntry[]
  TotalRows: number
}

export class EtoroSpotConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'etoro'
  readonly marketType: MarketType = 'spot'

  readonly capabilities: PlatformCapabilities = {
    platform: 'etoro',
    market_types: ['spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: [
      'roi', 'pnl', 'win_rate', 'max_drawdown', 'copiers', 'aum',
    ],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'Filters to crypto traders only (excludes stocks/ETFs/etc)',
      'PnL estimated from AUM × Gain',
      '3.4M total traders, top 2000 fetched',
    ],
  }

  private mapWindowToPeriod(window: Window): string {
    const m: Record<Window, string> = {
      '7d': 'CurrMonth',
      '30d': 'OneMonthAgo',
      '90d': 'ThreeMonthsAgo',
    }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const period = this.mapWindowToPeriod(window)
    const pageSize = 100
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `https://www.etoro.com/sapi/rankings/rankings/?Period=${period}&page=${page}&pagesize=${pageSize}`
        const data = await this.request<EtoroResponse>(url)

        if (!data?.Items?.length) break

        for (const entry of data.Items) {
          // Filter crypto-only
          if (EXCLUDED_ASSET_CLASSES.has(entry.TopTradedAssetClassName)) continue

          allTraders.push({
            platform: this.platform,
            market_type: this.marketType,
            trader_key: String(entry.CustomerId),
            display_name: entry.UserName || null,
            profile_url: `https://www.etoro.com/people/${entry.UserName}`,
            discovered_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            is_active: true,
            raw: entry as unknown as Record<string, unknown>,
          })
        }

        if (allTraders.length >= limit) break
      } catch (err) {
        if (page === 1) throw err // First page failure is fatal
        break // Subsequent pages: stop pagination
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
    // eToro profiles require web scraping, not available via rankings API
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // Individual snapshot requires fetching full leaderboard — use discoverLeaderboard instead
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as EtoroTraderEntry
    const roi = e.Gain ?? null
    const aum = e.AUMValue ?? null
    // Estimate PnL from AUM × gain
    const pnl = (roi != null && aum != null && aum > 0)
      ? aum * roi / 100
      : null

    return {
      trader_key: String(e.CustomerId),
      display_name: e.UserName || null,
      avatar_url: e.HasAvatar
        ? `https://etoro-cdn.etorostatic.com/avatars/${e.CustomerId}/150x150.jpg`
        : null,
      roi,
      pnl,
      win_rate: e.WinRatio ?? null,
      max_drawdown: e.PeakToValley != null ? Math.abs(e.PeakToValley) : null,
      followers: e.Copiers ?? null,
      copiers: e.Copiers ?? null,
      aum,
      platform_rank: null,
      trades_count: e.Trades != null ? Number(e.Trades) : null,
      sharpe_ratio: null,
    }
  }
}
