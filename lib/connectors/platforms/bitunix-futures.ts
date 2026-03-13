/**
 * Bitunix Futures Connector
 *
 * Fetches copy-trading leaderboard from Bitunix's public API.
 *
 * API: POST https://api.bitunix.com/copy/trading/v1/trader/list
 * - Public, no auth required
 * - 200/page, up to 2000 traders
 * - All values in decimal format (0.05 = 5%)
 * - 3600+ traders available
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

interface BitunixTraderEntry {
  uid: string
  nickname: string
  header: string | null
  roi: string | number   // Decimal string (0.05 = 5%)
  pl: string | number    // PnL in USDT (string)
  winRate: string | number // Decimal string (0.65 = 65%)
  mdd: string | number   // Decimal string (0.08 = 8%), may be negative
  currentFollow: number
  aum?: string | number  // AUM in USDT
  winCount?: number
}

interface BitunixResponse {
  code: number
  data?: {
    records?: BitunixTraderEntry[]
    list?: BitunixTraderEntry[] // Legacy field name
    total?: number
  }
}

export class BitunixFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'bitunix'
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'bitunix',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: [
      'roi', 'pnl', 'win_rate', 'max_drawdown', 'followers',
    ],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public POST API, no auth required',
      'All metrics in decimal format (×100 for percentage)',
      '3600+ traders available, 200/page',
    ],
  }

  private mapWindowToStatType(window: Window): number {
    const m: Record<Window, number> = { '7d': 1, '30d': 2, '90d': 3 }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const pageSize = 200
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []
    const statType = this.mapWindowToStatType(window)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const data = await this.request<BitunixResponse>(
          'https://api.bitunix.com/copy/trading/v1/trader/list',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              statisticType: statType,
              oderType: 'ROI',
              page,
              pageSize,
            }),
          }
        )

        const list = data?.data?.records || data?.data?.list || []
        if (!list.length) break

        for (const entry of list) {
          allTraders.push({
            platform: this.platform,
            market_type: this.marketType,
            trader_key: entry.uid,
            display_name: entry.nickname || null,
            profile_url: null,
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

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as BitunixTraderEntry
    // Parse string numbers and convert decimals → percentages
    const toNum = (v: string | number | null | undefined): number | null => {
      if (v == null) return null
      const n = typeof v === 'string' ? parseFloat(v) : v
      return isNaN(n) ? null : n
    }
    const toPct = (v: string | number | null | undefined): number | null => {
      const n = toNum(v)
      if (n == null) return null
      return Math.abs(n) <= 1 ? n * 100 : n
    }

    return {
      trader_key: e.uid,
      display_name: e.nickname || null,
      avatar_url: e.header || null,
      roi: toPct(e.roi),
      pnl: toNum(e.pl),
      win_rate: toPct(e.winRate),
      max_drawdown: e.mdd != null ? Math.abs(toPct(e.mdd) ?? 0) : null,
      followers: e.currentFollow ?? null,
      platform_rank: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: toNum(e.aum),
      copiers: null,
    }
  }
}
