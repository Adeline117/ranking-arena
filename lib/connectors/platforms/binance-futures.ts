/**
 * Binance Futures Connector
 *
 * Reference implementation for the connector framework.
 * Fetches data from Binance Futures copy trading leaderboard.
 *
 * Data sources:
 * - Leaderboard API: https://www.binance.com/bapi/futures/v1/public/future/leaderboard/
 * - Trader detail: https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo
 * - Performance: https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getOtherPerformance
 *
 * Anti-scraping notes:
 * - Uses CloudFlare protection
 * - Rate limit: ~20 req/min before soft block
 * - Requires realistic User-Agent and headers
 * - Periods: WEEKLY (7D), MONTHLY (30D), QUARTERLY (90D), YEARLY supported
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
  TraderProfile,
  SnapshotMetrics,
  TimeseriesPoint,
  TraderTimeseries,
} from '../../types/leaderboard'
import { calculateArenaScore } from '../../utils/arena-score'

// ============================================
// Binance API Types
// ============================================

interface BinanceLeaderboardResponse {
  data: {
    otherLeaderboardUrl: string
    list: BinanceTraderEntry[]
  } | null
  success: boolean
  code?: string
  message?: string
}

interface BinanceTraderEntry {
  encryptedUid: string
  nickName: string | null
  userPhotoUrl: string | null
  rank: number
  value: number           // ROI percentage
  pnl: number
  followerCount: number | null
  copyCount: number | null
  twitterUrl: string | null
  isTwTraderUrl: boolean | null
}

interface BinanceBaseInfoResponse {
  data: {
    nickName: string | null
    userPhotoUrl: string | null
    positionShared: boolean
    deliveryPositionShared: boolean
    followingCount: number | null
    followerCount: number | null
    twitterUrl: string | null
    introduction: string | null
    twpicdone: boolean
  } | null
  success: boolean
}

interface BinancePerformanceResponse {
  data: Array<{
    periodType: string      // WEEKLY, MONTHLY, QUARTERLY, YEARLY, ALL
    statisticsType: string  // ROI, PNL
    value: number
  }> | null
  success: boolean
}

interface BinancePositionResponse {
  data: {
    otherPositionRetList: Array<{
      symbol: string
      entryPrice: number
      markPrice: number
      pnl: number
      roe: number
      amount: number
      leverage: number
      tradeBefore: boolean
      updateTimeStamp: number
    }>
  } | null
  success: boolean
}

interface _BinancePerformanceDetailResponse {
  data: Array<{
    periodType: string
    value: number
    rank: number | null
  }> | null
  success: boolean
}

// ============================================
// Binance Futures Connector
// ============================================

export class BinanceFuturesConnector extends BaseConnector {
  readonly platform: LeaderboardPlatform = 'binance'
  readonly marketType: MarketType = 'futures'

  readonly capabilities: PlatformCapabilities = {
    platform: 'binance',
    market_types: ['futures', 'spot', 'web3'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: [
      'roi', 'pnl', 'win_rate', 'max_drawdown',
      'followers', 'copiers', 'aum', 'trades_count',
      'platform_rank',
    ],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'CloudFlare protected, requires realistic headers',
      'Leaderboard returns top 500 per window',
      'Trader detail requires encryptedUid',
      'Performance data available for all standard windows',
    ],
  }

  private readonly BASE_URL = 'https://www.binance.com/bapi/futures'

  // ============================================
  // Window Mapping
  // ============================================

  protected override mapWindowToPlatform(window: Window): string {
    const mapping: Record<Window, string> = {
      '7d': 'WEEKLY',
      '30d': 'MONTHLY',
      '90d': 'QUARTERLY',
    }
    return mapping[window]
  }

  private mapPlatformToWindow(periodType: string): Window | null {
    const mapping: Record<string, Window> = {
      'WEEKLY': '7d',
      'MONTHLY': '30d',
      'QUARTERLY': '90d',
    }
    return mapping[periodType] || null
  }

  // ============================================
  // Public Interface Implementation
  // ============================================

  async discoverLeaderboard(
    window: Window,
    limit: number = 100,
    offset: number = 0
  ): Promise<DiscoverResult> {
    const periodType = this.mapWindowToPlatform(window)

    const response = await this.request<BinanceLeaderboardResponse>(
      `${this.BASE_URL}/v3/public/future/leaderboard/getLeaderboardRank`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isShared: true,
          isTrader: false,
          periodType,
          statisticsType: 'ROI',
          tradeType: 'PERPETUAL',
        }),
      }
    )

    if (!response.success || !response.data?.list) {
      return {
        traders: [],
        total_available: 0,
        window,
        fetched_at: new Date().toISOString(),
      }
    }

    const traders: TraderSource[] = response.data.list
      .slice(offset, offset + limit)
      .map(entry => ({
        platform: this.platform,
        market_type: this.marketType,
        trader_key: entry.encryptedUid,
        display_name: entry.nickName,
        profile_url: `https://www.binance.com/en/futures-activity/leaderboard/user?encryptedUid=${entry.encryptedUid}`,
        discovered_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: true,
        raw: entry as unknown as Record<string, unknown>,
      }))

    return {
      traders,
      total_available: response.data.list.length,
      window,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    const response = await this.request<BinanceBaseInfoResponse>(
      `${this.BASE_URL}/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedUid: traderKey }),
      }
    )

    if (!response.success || !response.data) {
      return null
    }

    const data = response.data
    const profile: TraderProfile = {
      platform: this.platform,
      market_type: this.marketType,
      trader_key: traderKey,
      display_name: data.nickName,
      avatar_url: data.userPhotoUrl,
      bio: data.introduction,
      tags: [],
      profile_url: `https://www.binance.com/en/futures-activity/leaderboard/user?encryptedUid=${traderKey}`,
      followers: data.followerCount,
      copiers: null,  // Not directly available from base info
      aum: null,
      updated_at: new Date().toISOString(),
      last_enriched_at: new Date().toISOString(),
      provenance: this.buildProvenance(
        `${this.BASE_URL}/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo`
      ),
    }

    return {
      profile,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTraderSnapshot(
    traderKey: string,
    window: Window
  ): Promise<SnapshotResult | null> {
    // Fetch performance data
    const perfResponse = await this.request<BinancePerformanceResponse>(
      `${this.BASE_URL}/v1/public/future/leaderboard/getOtherPerformance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedUid: traderKey }),
      }
    )

    if (!perfResponse.success || !perfResponse.data) {
      return null
    }

    const periodType = this.mapWindowToPlatform(window)
    const roiEntry = perfResponse.data.find(
      e => e.periodType === periodType && e.statisticsType === 'ROI'
    )
    const pnlEntry = perfResponse.data.find(
      e => e.periodType === periodType && e.statisticsType === 'PNL'
    )

    // If no data for this window, return null
    if (!roiEntry && !pnlEntry) {
      return null
    }

    const roi = roiEntry ? roiEntry.value * 100 : null  // Convert to percentage
    const pnl = pnlEntry ? pnlEntry.value : null

    // Calculate Arena Score if we have enough data
    let arenaScore = null
    let returnScore = null
    let drawdownScore = null
    let stabilityScore = null

    if (roi !== null && pnl !== null) {
      const period = window === '7d' ? '7D' : window === '30d' ? '30D' : '90D'
      const scoreResult = calculateArenaScore(
        { roi, pnl, maxDrawdown: null, winRate: null },
        period
      )
      arenaScore = scoreResult.totalScore
      returnScore = scoreResult.returnScore
      drawdownScore = scoreResult.drawdownScore
      stabilityScore = scoreResult.stabilityScore
    }

    const metrics: SnapshotMetrics = {
      roi,
      pnl,
      win_rate: null,         // Requires additional API call
      max_drawdown: null,     // Requires additional API call
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: null,
      followers: null,        // Available from profile
      copiers: null,
      aum: null,
      platform_rank: null,
      arena_score: arenaScore,
      return_score: returnScore,
      drawdown_score: drawdownScore,
      stability_score: stabilityScore,
    }

    const qualityFlags = this.buildQualityFlags(
      metrics,
      window,
      this.isNativeWindow(window)
    )

    return {
      metrics,
      quality_flags: qualityFlags,
      fetched_at: new Date().toISOString(),
    }
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    // Fetch performance for all periods to build equity curve
    const perfResponse = await this.request<BinancePerformanceResponse>(
      `${this.BASE_URL}/v1/public/future/leaderboard/getOtherPerformance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedUid: traderKey }),
      }
    )

    if (!perfResponse.success || !perfResponse.data) {
      return { series: [], fetched_at: new Date().toISOString() }
    }

    // Build ROI timeseries from available period data
    const now = new Date()
    const roiPoints: TimeseriesPoint[] = []

    for (const entry of perfResponse.data) {
      if (entry.statisticsType === 'ROI') {
        const window = this.mapPlatformToWindow(entry.periodType)
        if (window) {
          roiPoints.push({
            ts: now.toISOString(),
            value: entry.value * 100,
          })
        }
      }
    }

    const series: TraderTimeseries[] = []

    if (roiPoints.length > 0) {
      series.push({
        platform: this.platform,
        market_type: this.marketType,
        trader_key: traderKey,
        series_type: 'equity_curve',
        as_of_ts: now.toISOString(),
        data: roiPoints,
        updated_at: now.toISOString(),
      })
    }

    return {
      series,
      fetched_at: now.toISOString(),
    }
  }

  normalize(raw: unknown): Record<string, unknown> {
    const entry = raw as BinanceTraderEntry
    return {
      trader_key: entry.encryptedUid,
      display_name: entry.nickName,
      avatar_url: entry.userPhotoUrl,
      roi: entry.value * 100,
      pnl: entry.pnl,
      followers: entry.followerCount,
      copiers: entry.copyCount,
      platform_rank: entry.rank,
    }
  }

  // ============================================
  // Additional Binance-Specific Methods
  // ============================================

  /**
   * Fetch current positions for a trader (if shared).
   */
  async fetchPositions(traderKey: string): Promise<BinancePositionResponse['data'] | null> {
    const response = await this.request<BinancePositionResponse>(
      `${this.BASE_URL}/v1/public/future/leaderboard/getOtherPosition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedUid: traderKey,
          tradeType: 'PERPETUAL',
        }),
      }
    )

    return response.success ? response.data : null
  }
}
