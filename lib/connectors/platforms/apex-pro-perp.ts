/**
 * ApeX Pro (Apex Protocol) Perp Connector
 *
 * ApeX Pro is a decentralized derivatives DEX (formerly on StarkEx, now Omni/multi-chain).
 * Website: pro.apex.exchange
 * API Docs: api-docs.pro.apex.exchange
 *
 * TODO: The public leaderboard API endpoint is not documented in the official API docs.
 * The ApeX Pro website has a leaderboard feature, but the API endpoint needs to be
 * discovered by inspecting network requests on the leaderboard page.
 *
 * Candidate endpoints (need verification):
 * - https://pro.apex.exchange/api/v3/leaderboard (based on v3 API pattern)
 * - https://pro.apex.exchange/api/v3/competition/ranking
 *
 * trader_key is an ApeX account ID or Ethereum address.
 */

import { BaseConnector } from '../base'
import { safeNumber } from '../utils'
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

interface ApexLeaderboardEntry {
  userId?: string
  accountId?: string
  ethAddress?: string
  nickname?: string
  username?: string
  pnl: number | string
  roi: number | string
  volume?: number | string
  rank?: number
  winRate?: number | string
  tradeCount?: number
}

interface ApexLeaderboardResponse {
  data?: {
    list?: ApexLeaderboardEntry[]
    leaderboard?: ApexLeaderboardEntry[]
    rankings?: ApexLeaderboardEntry[]
  }
  list?: ApexLeaderboardEntry[]
  leaderboard?: ApexLeaderboardEntry[]
}

export class ApexProPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'apex_pro'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'apex_pro',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Decentralized derivatives DEX (StarkEx / Omni)',
      'TODO: Leaderboard API endpoint needs to be confirmed',
      'API docs at api-docs.pro.apex.exchange do not document leaderboard endpoints',
    ],
  }

  private mapWindowToParam(window: Window): string {
    const m: Record<Window, string> = {
      '7d': 'WEEKLY',
      '30d': 'MONTHLY',
      '90d': 'ALL_TIME',
    }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // TODO: Replace with actual API endpoint once discovered.
    // The leaderboard page on pro.apex.exchange likely calls a backend API.
    // Candidate endpoints:
    //   - https://pro.apex.exchange/api/v3/leaderboard?period=WEEKLY&limit=500
    //   - https://api.pro.apex.exchange/api/v3/competition/ranking
    const period = this.mapWindowToParam(window)
    const data = await this.request<ApexLeaderboardResponse>(
      `https://pro.apex.exchange/api/v3/leaderboard?period=${period}&limit=${limit}`
    )

    const entries = data?.data?.list
      || data?.data?.leaderboard
      || data?.data?.rankings
      || data?.list
      || data?.leaderboard
      || []

    const traders: TraderSource[] = entries.slice(0, limit).map((entry, idx) => {
      const traderKey = String(entry.userId || entry.accountId || entry.ethAddress || '')

      return {
        platform: this.platform,
        market_type: this.marketType,
        trader_key: traderKey.toLowerCase(),
        display_name: entry.nickname || entry.username || null,
        profile_url: `https://pro.apex.exchange/trade/BTCUSDT/portfolio/${traderKey}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: {
          ...entry as unknown as Record<string, unknown>,
          _window: window,
          _rank: entry.rank ?? idx + 1,
        },
      }
    })

    return {
      traders,
      total_available: entries.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(_traderKey: string): Promise<ProfileResult | null> {
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // TODO: Implement using ApeX Pro API v3 account endpoints if available
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw ApeX Pro leaderboard entry.
   * ROI format needs to be verified — may be percentage or decimal.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as ApexLeaderboardEntry
    const rawRoi = safeNumber(e.roi)
    // ApeX likely returns ROI as percentage (35 = 35%) based on CEX-like patterns
    const roi = rawRoi != null ? Math.max(-100, Math.min(10000, rawRoi)) : null
    const pnl = safeNumber(e.pnl)
    const winRate = safeNumber(e.winRate)

    return {
      trader_key: String(e.userId || e.accountId || e.ethAddress || '').toLowerCase(),
      display_name: e.nickname || e.username || null,
      roi,
      pnl,
      platform_rank: e.rank ?? null,
      win_rate: winRate,
      max_drawdown: null,
      followers: null,
      trades_count: e.tradeCount ?? null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: null,
    }
  }
}
