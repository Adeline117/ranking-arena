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

interface _BinanceLeaderboardResponse {
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
    // New /friendly/ copy-trade API uses uppercase window format (7D, 30D, 90D)
    // Old leaderboard API used WEEKLY/MONTHLY/QUARTERLY
    const mapping: Record<Window, string> = {
      '7d': '7D',
      '30d': '30D',
      '90d': '90D',
    }
    return mapping[window]
  }

  private mapPlatformToWindow(periodType: string): Window | null {
    const mapping: Record<string, Window> = {
      // Old format (leaderboard performance API)
      'WEEKLY': '7d',
      'MONTHLY': '30d',
      'QUARTERLY': '90d',
      // New format (copy-trade API, changed ~2026-04-04)
      '7D': '7d',
      '30D': '30d',
      '90D': '90d',
    }
    return mapping[periodType] || null
  }

  // ============================================
  // Public Interface Implementation
  // ============================================

  async discoverLeaderboard(
    window: Window,
    limit: number = 2000,
    offset: number = 0
  ): Promise<DiscoverResult> {
    const periodType = this.mapWindowToPlatform(window)
    const pageSize = 20 // Binance returns max 20 per page
    const maxPages = Math.ceil(Math.min(limit, 2000) / pageSize)
    const allTraders: TraderSource[] = []

    for (let page = Math.floor(offset / pageSize) + 1; page <= maxPages + Math.floor(offset / pageSize); page++) {
      // New API endpoint (2026-03-15): /friendly/ path with home-page/query-list
      // Old endpoints (/public/future/copy-trade/lead-portfolio/ranking) return 404
      // This endpoint requires VPS proxy (geo-blocked + WAF protected)
      let response: Record<string, unknown> | null = null

      const requestBody = {
        pageNumber: page,
        pageSize,
        timeRange: periodType,
        dataType: 'ROI',
        favoriteOnly: false,
        hideFull: false,
        nickname: '',
        order: 'DESC',
        userAsset: 0,
        portfolioType: 'ALL',
        useAiRecommended: false,
      }

      const apiUrl = `${this.BASE_URL}/v1/friendly/future/copy-trade/home-page/query-list`
      const apiHeaders = {
        'Content-Type': 'application/json',
        'Origin': 'https://www.binance.com',
        'Referer': 'https://www.binance.com/en/copy-trading',
      }

      // Always try VPS proxy first — Binance is geo-blocked from Vercel hnd1
      // Direct request returns 200 with geo-block message, not a HTTP error
      response = await this.proxyViaVPS<Record<string, unknown>>(
        apiUrl,
        { method: 'POST', body: requestBody, headers: apiHeaders }
      )

      // Fallback: try direct (works from non-restricted IPs like Mac Mini)
      // Binance success: code = "000000" (string)
      // Binance geo-block: code = 0 (number)
      const hasValidData = response && 
        (response.code === "000000" || (response.data as Record<string, unknown> | null)?.list)
      
      if (!hasValidData) {
        try {
          response = await this.request<Record<string, unknown>>(
            apiUrl,
            { method: 'POST', headers: apiHeaders, body: JSON.stringify(requestBody) }
          )
        } catch (err) {
          this.logger.debug('Binance futures direct API fallback:', err instanceof Error ? err.message : String(err))
        }
      }

      if (!response) break

      // New response format: { code: "000000", data: { total, list: [...] } }
      const data = response.data as Record<string, unknown> | null
      const list = (data?.list || []) as Record<string, unknown>[]
      if (!list.length) break

      for (const entry of list) {
        allTraders.push({
          platform: this.platform,
          market_type: this.marketType,
          trader_key: String(entry.leadPortfolioId || entry.encryptedUid || ''),
          display_name: (entry.nickname as string) ?? (entry.nickName as string) ?? null,
          profile_url: `https://www.binance.com/en/copy-trading/lead-details?portfolioId=${entry.leadPortfolioId}`,
          discovered_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          is_active: true,
          raw: entry,
        })
      }

      if (list.length < pageSize) break
      if (allTraders.length >= limit) break
      await new Promise(r => setTimeout(r, 500))
    }

    return {
      traders: allTraders.slice(0, limit),
      total_available: allTraders.length,
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

    // Performance API may return old format (WEEKLY/MONTHLY/QUARTERLY) or
    // new format (7D/30D/90D). Try both for resilience.
    const newPeriod = this.mapWindowToPlatform(window)
    const OLD_TO_NEW: Record<string, string> = { '7D': 'WEEKLY', '30D': 'MONTHLY', '90D': 'QUARTERLY' }
    const oldPeriod = OLD_TO_NEW[newPeriod]
    const matchPeriod = (e: { periodType?: string }) =>
      e.periodType === newPeriod || e.periodType === oldPeriod
    const roiEntry = perfResponse.data.find(
      e => matchPeriod(e) && e.statisticsType === 'ROI'
    )
    const pnlEntry = perfResponse.data.find(
      e => matchPeriod(e) && e.statisticsType === 'PNL'
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
            timeRange: newPeriod,
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
    } catch (err) {
      this.logger.debug('Binance futures copy-trade detail fallback:', err instanceof Error ? err.message : String(err))
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
      } catch (err) {
        this.logger.debug('Binance futures base-info fallback:', err instanceof Error ? err.message : String(err))
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
  /**
   * Normalize raw Binance leaderboard entry.
   * New API (2026-03-15) returns: leadPortfolioId, nickname, avatarUrl,
   * roi, pnl, mdd, winRate, sharpRatio, aum, currentCopyCount, chartItems.
   * Old API returned: encryptedUid, nickName, value (ROI decimal), pnl, followerCount.
   */
  normalize(raw: unknown): Record<string, unknown> {
    const entry = raw as Record<string, unknown>

    // New API: roi is already percentage (6980.41 = 6980.41%)
    // Old API: value was decimal (0.5 = 50%)
    let roi: number | null = null
    if (entry.roi != null) {
      roi = Number(entry.roi)
    } else if (entry.value != null) {
      roi = Number(entry.value) * 100
    }

    const winRate = entry.winRate != null ? Number(entry.winRate) : null
    const mdd = entry.mdd != null ? Math.abs(Number(entry.mdd)) : null

    return {
      trader_key: entry.leadPortfolioId ?? entry.encryptedUid ?? null,
      display_name: entry.nickname ?? entry.nickName ?? null,
      avatar_url: entry.avatarUrl ?? entry.userPhotoUrl ?? null,
      roi,
      pnl: entry.pnl != null ? Number(entry.pnl) : null,
      win_rate: winRate,
      max_drawdown: mdd,
      trades_count: null,
      followers: entry.currentCopyCount != null ? Number(entry.currentCopyCount) : (entry.followerCount != null ? Number(entry.followerCount) : null),
      copiers: entry.currentCopyCount != null ? Number(entry.currentCopyCount) : (entry.copyCount != null ? Number(entry.copyCount) : null),
      aum: entry.aum != null ? Number(entry.aum) : null,
      sharpe_ratio: entry.sharpRatio != null && Math.abs(Number(entry.sharpRatio)) <= 20 ? Number(entry.sharpRatio) : null,
      platform_rank: entry.rank != null ? Number(entry.rank) : null,
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
