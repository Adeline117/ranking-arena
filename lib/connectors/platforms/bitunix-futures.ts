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
  uid: string | number
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
    const _statType = this.mapWindowToStatType(window)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const data = await this.request<BitunixResponse>(
          'https://api.bitunix.com/copy/trading/v1/trader/list',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pageNo: page,
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
            trader_key: String(entry.uid),
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
    // Parse string numbers
    const toNum = (v: string | number | null | undefined): number | null => {
      if (v == null) return null
      const n = typeof v === 'string' ? parseFloat(v) : v
      return !Number.isFinite(n) ? null : n
    }

    // Bitunix API always returns ratio format: roi=8.53 means 853%, winRate=0.78 means 78%
    // Always multiply by 100 to convert to percentage
    const roiRaw = toNum(e.roi)
    const roi = roiRaw != null ? roiRaw * 100 : null

    const winRateRaw = toNum(e.winRate)
    const winRate = winRateRaw != null ? winRateRaw * 100 : null

    const mddRaw = toNum(e.mdd)
    const mdd = mddRaw != null ? Math.abs(mddRaw * 100) : null

    return {
      trader_key: String(e.uid),
      display_name: e.nickname || null,
      avatar_url: e.header || null,
      roi,
      pnl: toNum(e.pl),
      win_rate: winRate,
      max_drawdown: mdd,
      followers: e.currentFollow ?? null,
      platform_rank: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: toNum(e.aum),
      copiers: null,
    }
  }
}
