/**
 * BTCC Futures Connector
 *
 * Fetches copy-trading leaderboard data from BTCC's public API.
 *
 * API: POST https://www.btcc.com/documentary/trader/page
 * - Public, no auth required
 * - 50/page, up to 1000 traders
 * - ROI: rateProfit in percentage form (27.5 = 27.5%)
 * - MDD: maxBackRate in basis points (789.0 = 7.89%)
 * - Single fetch shared across all periods (no period filter)
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

interface BtccTraderEntry {
  traderId: string
  nickName: string
  avatarPic: string | null
  rateProfit: number        // ROI in percentage
  totalNetProfit: number    // PnL in USDT
  winRate: number           // Already percentage
  maxBackRate: number       // MDD in basis points (÷100 for %)
  followNum: number
  orderNum?: number
  traderDays?: number
}

interface BtccResponse {
  code: number
  rows?: BtccTraderEntry[]
  data?: {
    rows?: BtccTraderEntry[]
    list?: BtccTraderEntry[]
    records?: BtccTraderEntry[]
    total?: number
  }
}

export class BtccFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'btcc'
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'btcc',
    market_types: ['futures'],
    native_windows: ['90d'],
    available_fields: [
      'roi', 'pnl', 'win_rate', 'max_drawdown', 'followers',
    ],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public POST API, no auth required',
      'No period parameter — same data for all windows',
      'MDD in basis points (divide by 100)',
      '1750 traders total',
    ],
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const pageSize = 50
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = 'https://www.btcc.com/documentary/trader/page'
        const reqBody = { pageNum: page, pageSize, sortType: 4, nickName: '', flag: 'en-US' }
        let data: BtccResponse
        try {
          data = await this.request<BtccResponse>(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody),
          })
        } catch (err) {
          this.logger.debug('BTCC direct API fallback:', err instanceof Error ? err.message : String(err))
          const vpsData = await this.proxyViaVPS<BtccResponse>(url, {
            method: 'POST',
            body: reqBody,
            headers: { 'Content-Type': 'application/json' },
          })
          if (!vpsData) throw new Error('Both direct API and VPS proxy failed for btcc')
          data = vpsData
        }

        // Handle multiple response formats
        // Handle both formats: top-level { rows } and nested { data: { rows } }
        const list = data?.rows || data?.data?.rows || data?.data?.list || data?.data?.records || []
        if (!list.length) break

        for (const entry of list) {
          allTraders.push({
            platform: this.platform,
            market_type: this.marketType,
            trader_key: String(entry.traderId),
            display_name: entry.nickName || null,
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
    const e = raw as BtccTraderEntry & { netProfitList?: string }
    return {
      trader_key: String(e.traderId),
      display_name: e.nickName || null,
      avatar_url: e.avatarPic || null,
      roi: e.rateProfit ?? null,
      pnl: e.totalNetProfit ?? null,
      win_rate: e.winRate ?? null,
      // MDD in basis points → percentage, clamped to 0-100
      max_drawdown: e.maxBackRate != null ? Math.min(Math.abs(e.maxBackRate / 100), 100) : null,
      followers: e.followNum ?? null,
      trades_count: e.orderNum ?? null,
      platform_rank: null,
      sharpe_ratio: (() => {
        if (!e.netProfitList || typeof e.netProfitList !== 'string') return null
        const values = e.netProfitList.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v))
        if (values.length < 7) return null
        const returns = values.slice(1).map((v, i) => v - values[i])
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
        const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
        if (std <= 0) return null
        const sharpe = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
        return Math.max(-20, Math.min(20, sharpe))
      })(),
      aum: null,
      copiers: null,
    }
  }
}
