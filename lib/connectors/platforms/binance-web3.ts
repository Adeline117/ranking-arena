/**
 * Binance Web3 Connector
 *
 * Fetches wallet leaderboard from Binance Web3's public API.
 * Queries 3 chains (BSC, Base, Solana) in sequence.
 *
 * API: GET https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query
 * - Public, no auth required
 * - 25/page (API max), up to ~500 traders across 3 chains
 * - ROI: realizedPnlPercent in decimal (0.27 = 27%)
 * - Win rate: decimal (0.65 = 65%)
 */

import { BaseConnector } from '../base'
import { safeNumber, safePercent, safeStr } from '../utils'
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

// Chain IDs for Binance Web3
const CHAINS = [
  { id: '56', name: 'BSC' },
  { id: '8453', name: 'Base' },
  { id: 'CT_501', name: 'Solana' },
]

interface BinanceWeb3Entry {
  address: string
  addressLabel: string | null
  addressLogo: string | null
  realizedPnl: number
  realizedPnlPercent: number    // Decimal (0.27 = 27%)
  winRate: number               // Decimal (0.65 = 65%)
}

interface BinanceWeb3Response {
  data?: {
    list?: BinanceWeb3Entry[]
    total?: number
  }
  success?: boolean
}

export class BinanceWeb3Connector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'binance_web3'
  readonly marketType: MarketType = 'web3'

  readonly capabilities: PlatformCapabilities = {
    platform: 'binance_web3',
    market_types: ['web3'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Public API, no auth required',
      'Queries BSC + Base + Solana chains',
      'ROI and win_rate in decimal format (×100)',
      'No MDD available',
    ],
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    const period = window === '7d' ? '7d' : window === '30d' ? '30d' : '90d'
    const seen = new Set<string>()
    const allTraders: TraderSource[] = []

    for (const chain of CHAINS) {
      const maxPages = 40
      for (let page = 1; page <= maxPages; page++) {
        try {
          const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query?chainId=${chain.id}&period=${period}&tag=ALL&pageNo=${page}&pageSize=25`
          const headers = {
            'Origin': 'https://web3.binance.com',
            'Referer': 'https://web3.binance.com/en/wallet-direct',
          }
          let data: BinanceWeb3Response | null = null
          try {
            data = await this.request<BinanceWeb3Response>(url, { headers })
          } catch { /* direct may be geo-blocked with empty 200 */ }
          // Binance returns 200 with empty body for geo-blocked requests — fallback to VPS
          if (!data?.data?.list?.length && !(data?.data as Record<string, unknown>)?.data) {
            data = await this.proxyViaVPS<BinanceWeb3Response>(url, { headers }) || data
          }

          // API returns both { data: { list: [...] } } and { data: { data: [...] } } formats
          const list = data?.data?.list || (data?.data as Record<string, unknown>)?.data as BinanceWeb3Entry[] || []
          if (!list.length) break

          for (const entry of list) {
            if (!entry.address || seen.has(entry.address.toLowerCase())) continue
            seen.add(entry.address.toLowerCase())

            allTraders.push({
              platform: this.platform,
              market_type: this.marketType,
              trader_key: entry.address.toLowerCase(),
              display_name: entry.addressLabel || `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`,
              profile_url: `https://web3.binance.com/en/wallet-direct/address/${entry.address}`,
              discovered_at: new Date().toISOString(),
              last_seen_at: new Date().toISOString(),
              is_active: true,
              raw: { ...entry as unknown as Record<string, unknown>, _chain: chain.name },
            })
          }

          if (list.length < 25) break
          if (allTraders.length >= limit) break
        } catch (err) {
          if (page === 1 && allTraders.length === 0 && chain === CHAINS[0]) throw err
          break
        }
      }
      if (allTraders.length >= limit) break
    }

    return {
      traders: allTraders.slice(0, limit),
      total_available: allTraders.length,
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

  /**
   * Normalize raw Binance Web3 entry.
   * realizedPnlPercent and winRate are decimals (0.27 = 27%), always ×100.
   * Uses safePercent to prevent NaN from missing fields.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as BinanceWeb3Entry
    return {
      trader_key: e.address ? e.address.toLowerCase() : null,
      display_name: safeStr(e.addressLabel) || (e.address ? `${e.address.slice(0, 6)}...${e.address.slice(-4)}` : null),
      avatar_url: safeStr(e.addressLogo),
      // Decimal → percentage (safePercent handles null/NaN)
      roi: safePercent(e.realizedPnlPercent, { isRatio: true }),
      pnl: safeNumber(e.realizedPnl),
      win_rate: safePercent(e.winRate, { isRatio: true }),
      max_drawdown: null,
      followers: null,
      trades_count: null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      platform_rank: null,
    }
  }
}
