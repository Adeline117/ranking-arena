/**
 * RabbitX Perp Connector
 *
 * RabbitX is a decentralized perpetuals exchange built on Starknet.
 * Website: rabbitx.io / app.rabbitx.io
 * API Docs: docs.rabbitx.com/api-documentation
 *
 * TODO: RabbitX does not document a public leaderboard API endpoint.
 * The API docs cover trading endpoints (orders, fills, positions) but not
 * leaderboard/ranking data. The website may have a competition/leaderboard
 * page whose backend API needs to be discovered via network inspection.
 *
 * Candidate endpoints (need verification):
 * - https://api.prod.rabbitx.io/leaderboard?period=week&limit=500
 * - https://api.rabbitx.io/v1/leaderboard
 *
 * trader_key is a wallet address (0x...).
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

interface RabbitXLeaderboardEntry {
  wallet?: string
  address?: string
  profileId?: string
  displayName?: string
  pnl: number | string
  roi: number | string
  volume?: number | string
  rank?: number
  winRate?: number | string
  tradesCount?: number
}

interface RabbitXLeaderboardResponse {
  result?: RabbitXLeaderboardEntry[]
  data?: RabbitXLeaderboardEntry[]
  leaderboard?: RabbitXLeaderboardEntry[]
}

export class RabbitXPerpConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'rabbitx'
  readonly marketType: MarketType = 'perp'

  readonly capabilities: PlatformCapabilities = {
    platform: 'rabbitx',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl'],
    has_timeseries: false,
    has_profiles: false,
    scraping_difficulty: 2,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'DEX on Starknet — no copy trading features',
      'trader_key is a wallet address (0x...)',
      'TODO: Leaderboard API endpoint not documented — needs network inspection',
      'API docs at docs.rabbitx.com cover trading only, not leaderboard',
    ],
  }

  private mapWindowToParam(window: Window): string {
    const m: Record<Window, string> = {
      '7d': 'week',
      '30d': 'month',
      '90d': 'all',
    }
    return m[window]
  }

  async discoverLeaderboard(
    window: Window,
    limit: number = 500,
    _offset: number = 0
  ): Promise<DiscoverResult> {
    // TODO: Replace with actual API endpoint once discovered.
    // RabbitX API base: https://api.prod.rabbitx.io
    // The leaderboard endpoint is not documented — needs network inspection.
    const period = this.mapWindowToParam(window)
    const data = await this.request<RabbitXLeaderboardResponse>(
      `https://api.prod.rabbitx.io/leaderboard?period=${period}&limit=${limit}`
    )

    const entries = data?.result || data?.data || data?.leaderboard || []

    const traders: TraderSource[] = entries.slice(0, limit).map((entry, idx) => {
      const wallet = String(entry.wallet || entry.address || entry.profileId || '')
      const shortAddr = wallet.length > 10
        ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
        : wallet

      return {
        platform: this.platform,
        market_type: this.marketType,
        trader_key: wallet.toLowerCase(),
        display_name: entry.displayName || shortAddr || null,
        profile_url: `https://app.rabbitx.io/trader/${wallet}`,
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
    // RabbitX is a DEX — no user profiles
    return null
  }

  async fetchTraderSnapshot(_traderKey: string, _window: Window): Promise<SnapshotResult | null> {
    // TODO: RabbitX private endpoints include account info (balance, positions, fills).
    // Could potentially use /account and /fills endpoints with API key for enrichment,
    // but public trader data requires the leaderboard or profile endpoint.
    return null
  }

  async fetchTimeseries(_traderKey: string): Promise<TimeseriesResult> {
    return { series: [], fetched_at: new Date().toISOString() }
  }

  /**
   * Normalize raw RabbitX leaderboard entry.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const e = raw as RabbitXLeaderboardEntry
    const rawRoi = safeNumber(e.roi)
    // Smart ROI detection: if |roi| <= 10, assume decimal; otherwise percentage
    const roi = rawRoi != null
      ? (Math.abs(rawRoi) <= 10 ? rawRoi * 100 : rawRoi)
      : null
    const pnl = safeNumber(e.pnl)
    const winRate = safeNumber(e.winRate)

    return {
      trader_key: String(e.wallet || e.address || e.profileId || '').toLowerCase(),
      display_name: e.displayName || null,
      roi,
      pnl,
      platform_rank: e.rank ?? null,
      win_rate: winRate,
      max_drawdown: null,
      followers: null,
      trades_count: e.tradesCount ?? null,
      sharpe_ratio: null,
      aum: null,
      copiers: null,
      avatar_url: null,
    }
  }
}
