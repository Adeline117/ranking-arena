/**
 * Bitfinex Connector
 *
 * Fetches trader rankings from Bitfinex's public v2 rankings API.
 *
 * API: GET https://api-pub.bitfinex.com/v2/rankings/{Key}:{TimeFrame}:tGLOBAL:USD/hist
 * - Public, no auth required
 * - No pagination — single call returns top ~120 traders per key
 * - Two ranking keys: plu_diff (PnL change), plr (PnL ratio)
 * - ROI estimated from PnL / equity proxy
 * - Raw response is array format [mts, ?, username, rank, ?, ?, value, ...]
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

type BitfinexRow = [
  number,   // mts
  unknown,
  string,   // username
  number,   // rank
  unknown,
  unknown,
  number,   // value (PnL)
  ...unknown[]
]

export class BitfinexFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'bitfinex'
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'bitfinex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],
    available_fields: ['pnl', 'platform_rank'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'Max ~120 traders per key × timeframe',
      'ROI estimated from PnL / equity proxy',
      '30D and 90D use same 1M timeframe',
    ],
  }

  private mapWindowToTimeframe(window: Window): string {
    return window === '7d' ? '1w' : '1M'
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const timeframe = this.mapWindowToTimeframe(window)
    const traderMap = new Map<string, TraderSource>()

    // Fetch equity proxy (inception unrealized profit) for ROI estimation
    const equityMap = new Map<string, number>()
    try {
      const equityRows = await this.request<BitfinexRow[]>(
        `https://api-pub.bitfinex.com/v2/rankings/plu:1M:tGLOBAL:USD/hist`
      )
      if (Array.isArray(equityRows)) {
        for (const row of equityRows) {
          if (Array.isArray(row) && row[2] && row[6] != null) {
            equityMap.set(String(row[2]).toLowerCase(), Number(row[6]))
          }
        }
      }
    } catch {
      // Equity proxy not critical — ROI will be null
    }

    // Fetch PnL diff rankings (primary data source)
    // plu_diff = actual PnL in USD, plr = PnL ratio ranking (not directly usable as ROI)
    for (const key of ['plu_diff', 'plr']) {
      try {
        const rows = await this.request<BitfinexRow[]>(
          `https://api-pub.bitfinex.com/v2/rankings/${key}:${timeframe}:tGLOBAL:USD/hist`
        )

        if (!Array.isArray(rows)) continue

        for (const row of rows) {
          if (!Array.isArray(row) || !row[2]) continue
          const username = String(row[2])
          const id = username.toLowerCase()
          const value = Number(row[6]) || 0

          if (traderMap.has(id)) continue

          // For plu_diff, value is PnL in USD; for plr, value is a ratio metric (not ROI%)
          const pnl = key === 'plu_diff' ? value : 0

          // Estimate ROI from PnL / equity proxy
          const equity = equityMap.get(id)
          let roi: number | null = null
          if (equity != null && Math.abs(equity) > 1 && pnl !== 0) {
            roi = Math.max(-500, Math.min(50000, (pnl / Math.abs(equity)) * 100))
          }

          traderMap.set(id, {
            platform: this.platform,
            market_type: this.marketType,
            trader_key: id,
            display_name: username,
            profile_url: `https://www.bitfinex.com/`,
            discovered_at: new Date().toISOString(),
            last_seen_at: new Date().toISOString(),
            is_active: true,
            raw: {
              username,
              rank: Number(row[3]) || null,
              pnl,
              key,
              timeframe,
              equity: equityMap.get(id) ?? null,
              roi,
            },
          })
        }
      } catch (err) {
        if (traderMap.size === 0) throw err
        // Continue with what we have
      }
    }

    const traders = Array.from(traderMap.values()).slice(0, limit)

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
    const e = raw as Record<string, unknown>
    return {
      trader_key: e.username ? String(e.username).toLowerCase() : null,
      display_name: e.username ? String(e.username) : null,
      roi: e.roi != null ? Number(e.roi) : null,
      pnl: e.pnl != null ? Number(e.pnl) : null,
      platform_rank: e.rank != null ? Number(e.rank) : null,
      win_rate: null,
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: e.username ? `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(String(e.username))}` : null,
    }
  }
}
