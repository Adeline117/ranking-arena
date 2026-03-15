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
import { warnValidate } from '../schemas'
import {
  BinanceFuturesLeaderboardResponseSchema,
  BinanceFuturesBaseInfoResponseSchema,
  BinanceFuturesPerformanceResponseSchema,
  BinanceFuturesPositionResponseSchema,
} from './schemas'
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

/**
 * Response from the copy-trade lead-portfolio detail endpoint.
 * Provides win_rate, max_drawdown, trades_count, sharpe_ratio, avg_holding_time.
 */
interface BinanceCopyTradeDetailResponse {
  code?: string
  data?: {
    portfolioId?: string
    roi?: number
    pnl?: number
    winRate?: number
    maxDrawdown?: number
    mdd?: number
    tradeCount?: number
    sharpeRatio?: number
    avgHoldingTime?: number
    followerCount?: number
    currentCopyCount?: number
    aum?: number
    copierPnl?: number
    leadingDays?: number
  } | null
  success?: boolean
}

/**
 * Response from the copy-trade lead base info endpoint.
 * Provides followers, copiers, and aum.
 */
interface BinanceCopyTradeBaseInfoResponse {
  code?: string
  data?: {
    portfolioId?: string
    nickName?: string
    followerCount?: number
    currentCopyCount?: number
    aum?: number
  } | null
  success?: boolean
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

    // Try v1/searchLeaderboard (verified working via VPS proxy)
    // v3/getLeaderboardRank returns 404 since ~2026-03-14
    let _rawLb: BinanceLeaderboardResponse
    try {
      _rawLb = await this.request<BinanceLeaderboardResponse>(
        `${this.BASE_URL}/v1/public/future/leaderboard/searchLeaderboard`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isShared: true,
            isTrader: true,
            periodType,
            statisticsType: 'ROI',
          }),
        }
      )
    } catch {
      // Fallback: copy-trade leader portfolio list
      _rawLb = await this.request<BinanceLeaderboardResponse>(
        `${this.BASE_URL}/v2/public/future/leaderboard/getLeaderboardRank`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isShared: true,
            isTrader: true,
            periodType,
            statisticsType: 'ROI',
            tradeType: 'PERPETUAL',
          }),
        }
      )
    }
    const response = warnValidate(BinanceFuturesLeaderboardResponseSchema, _rawLb, 'binance-futures/leaderboard')

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
        display_name: entry.nickName ?? null,
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
    const _rawProfile = await this.request<BinanceBaseInfoResponse>(
      `${this.BASE_URL}/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedUid: traderKey }),
      }
    )
    const response = warnValidate(BinanceFuturesBaseInfoResponseSchema, _rawProfile, 'binance-futures/baseInfo')

    if (!response.success || !response.data) {
      return null
    }

    const data = response.data
    const profile: TraderProfile = {
      platform: this.platform,
      market_type: this.marketType,
      trader_key: traderKey,
      display_name: data.nickName ?? null,
      avatar_url: data.userPhotoUrl ?? null,
      bio: data.introduction ?? null,
      tags: [],
      profile_url: `https://www.binance.com/en/futures-activity/leaderboard/user?encryptedUid=${traderKey}`,
      followers: data.followerCount ?? null,
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
    // Fetch performance data (ROI + PnL per period)
    const _rawPerf = await this.request<BinancePerformanceResponse>(
      `${this.BASE_URL}/v1/public/future/leaderboard/getOtherPerformance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedUid: traderKey }),
      }
    )
    const perfResponse = warnValidate(BinanceFuturesPerformanceResponseSchema, _rawPerf, 'binance-futures/performance')

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

    const roi = roiEntry?.value != null ? roiEntry.value * 100 : null  // Convert to percentage
    const pnl = pnlEntry?.value ?? null

    // Fetch additional detail data from copy-trade APIs (best-effort)
    let winRate: number | null = null
    let maxDrawdown: number | null = null
    let tradesCount: number | null = null
    let followers: number | null = null
    let copiers: number | null = null
    let aum: number | null = null
    let sharpeRatio: number | null = null
    let avgHoldingHours: number | null = null

    // Try the copy-trade detail endpoint first — it has the most fields
    try {
      const detailResponse = await this.request<BinanceCopyTradeDetailResponse>(
        `https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade/lead-portfolio/detail`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://www.binance.com',
            'Referer': 'https://www.binance.com/en/copy-trading',
          },
          body: JSON.stringify({
            encryptedUid: traderKey,
            timeRange: periodType,
          }),
        }
      )

      if (detailResponse?.data) {
        const d = detailResponse.data
        winRate = d.winRate != null ? (d.winRate <= 1 ? d.winRate * 100 : d.winRate) : null
        maxDrawdown = d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : (d.mdd != null ? Math.abs(d.mdd) : null)
        tradesCount = d.tradeCount ?? null
        sharpeRatio = d.sharpeRatio ?? null
        avgHoldingHours = d.avgHoldingTime ?? null
        followers = d.followerCount ?? null
        copiers = d.currentCopyCount ?? null
        aum = d.aum ?? null
      }
    } catch {
      // Detail endpoint failed — try the base-info endpoint as fallback for social fields
      try {
        const baseInfoResponse = await this.request<BinanceCopyTradeBaseInfoResponse>(
          `https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade/lead-portfolio/query-lead-base-info`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Origin': 'https://www.binance.com',
              'Referer': 'https://www.binance.com/en/copy-trading',
            },
            body: JSON.stringify({ portfolioId: traderKey }),
          }
        )

        if (baseInfoResponse?.data) {
          const b = baseInfoResponse.data
          followers = b.followerCount ?? null
          copiers = b.currentCopyCount ?? null
          aum = b.aum ?? null
        }
      } catch {
        // Both endpoints failed — continue with basic ROI/PnL only
      }
    }

    // Calculate Arena Score with all available data
    let arenaScore = null
    let returnScore = null
    let drawdownScore = null
    let stabilityScore = null

    if (roi !== null && pnl !== null) {
      const period = window === '7d' ? '7D' : window === '30d' ? '30D' : '90D'
      const scoreResult = calculateArenaScore(
        { roi, pnl, maxDrawdown: maxDrawdown ?? null, winRate: winRate ?? null },
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
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      sharpe_ratio: sharpeRatio,
      sortino_ratio: null,
      trades_count: tradesCount,
      followers,
      copiers,
      aum,
      platform_rank: null,
      arena_score: arenaScore,
      return_score: returnScore,
      drawdown_score: drawdownScore,
      stability_score: stabilityScore,
      avg_holding_hours: avgHoldingHours,
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
    const _rawPerfTs = await this.request<BinancePerformanceResponse>(
      `${this.BASE_URL}/v1/public/future/leaderboard/getOtherPerformance`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedUid: traderKey }),
      }
    )
    const perfResponse = warnValidate(BinanceFuturesPerformanceResponseSchema, _rawPerfTs, 'binance-futures/timeseries')

    if (!perfResponse.success || !perfResponse.data) {
      return { series: [], fetched_at: new Date().toISOString() }
    }

    // Build ROI timeseries from available period data
    const now = new Date()
    const roiPoints: TimeseriesPoint[] = []

    for (const entry of perfResponse.data) {
      if (entry.statisticsType === 'ROI' && entry.periodType && entry.value != null) {
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

  /**
   * Normalize raw leaderboard entry to standard fields.
   * Leaderboard API provides: encryptedUid, nickName, userPhotoUrl, rank,
   * value (ROI decimal), pnl, followerCount, copyCount.
   * win_rate, max_drawdown, trades_count require copy-trade detail API
   * and are filled by enrichment — set to null here.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const entry = raw as BinanceTraderEntry
    return {
      trader_key: entry.encryptedUid,
      display_name: entry.nickName ?? null,
      avatar_url: entry.userPhotoUrl ?? null,
      roi: entry.value != null ? entry.value * 100 : null,
      pnl: entry.pnl ?? null,
      win_rate: null,        // Requires copy-trade detail API (enrichment)
      max_drawdown: null,    // Requires copy-trade detail API (enrichment)
      trades_count: null,    // Requires copy-trade detail API (enrichment)
      followers: entry.followerCount ?? null,
      copiers: entry.copyCount ?? null,
      aum: null,
      sharpe_ratio: null,
      platform_rank: entry.rank ?? null,
    }
  }

  // ============================================
  // Additional Binance-Specific Methods
  // ============================================

  /**
   * Fetch current positions for a trader (if shared).
   */
  async fetchPositions(traderKey: string): Promise<Record<string, unknown> | null> {
    const _rawPos = await this.request<BinancePositionResponse>(
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
    const response = warnValidate(BinanceFuturesPositionResponseSchema, _rawPos, 'binance-futures/positions')

    return response.success ? (response.data as Record<string, unknown> | null) : null
  }
}
