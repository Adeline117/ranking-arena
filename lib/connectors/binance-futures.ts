/**
 * Binance Futures Copy Trading Connector
 * Fetches leaderboard, profiles, snapshots, and timeseries via Binance API.
 *
 * Uses direct HTTP requests (no browser automation) for speed and reliability.
 * Falls back gracefully when individual fields are unavailable.
 */

import type { PlatformConnector } from './types'
import type {
  SnapshotWindow,
  ConnectorTraderProfile,
  ConnectorSnapshot,
  ConnectorTimeseries,
  LeaderboardEntry,
  SnapshotMetrics,
  EquityCurvePoint,
} from '@/lib/types/trading-platform'
import { DelayRateLimiter } from './rate-limiter'
import { SimpleCircuitBreaker } from './circuit-breaker'
import {
  calculateArenaScore,
  type Period,
} from '@/lib/utils/arena-score'

const BINANCE_COPY_TRADE_API = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade'
const BINANCE_COPY_TRADE_V2 = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade'

const WINDOW_TO_PERIOD: Record<SnapshotWindow, string> = {
  '7D': 'WEEKLY',
  '30D': 'MONTHLY',
  '90D': 'QUARTERLY',
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

// External API response type - loosely typed since Binance API shapes vary per endpoint
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BinanceApiResponse = Record<string, any>

export class BinanceFuturesConnector implements PlatformConnector {
  readonly platform = 'binance_futures' as const
  private rateLimiter = new DelayRateLimiter(2500)
  private circuitBreaker = new SimpleCircuitBreaker(5, 60000)

  async discoverLeaderboard(window: SnapshotWindow, limit = 100): Promise<LeaderboardEntry[]> {
    const period = WINDOW_TO_PERIOD[window]
    const pageSize = 20
    const pages = Math.ceil(limit / pageSize)
    const results: LeaderboardEntry[] = []

    for (let page = 1; page <= pages && results.length < limit; page++) {
      await this.rateLimiter.acquire()

      const data = await this.circuitBreaker.execute(() =>
        this.apiRequest(`${BINANCE_COPY_TRADE_API}/home-page/query-list`, {
          pageNumber: page,
          pageSize,
          timeRange: period,
          dataType: 'ROI',
          favoriteOnly: false,
        })
      )

      const list = data?.data?.list || data?.data?.data || []
      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list) {
        const entry = this.parseLeaderboardEntry(item, results.length + 1)
        if (entry) {
          results.push(entry)
        }
      }
    }

    return results.slice(0, limit)
  }

  async fetchTraderProfile(traderKey: string): Promise<ConnectorTraderProfile> {
    await this.rateLimiter.acquire()

    const data = await this.circuitBreaker.execute(() =>
      this.apiRequest(`${BINANCE_COPY_TRADE_V2}/lead-portfolio/query-portfolio`, {
        portfolioId: traderKey,
      })
    )

    const portfolio = data?.data
    if (!portfolio) {
      return {
        trader_key: traderKey,
        display_name: null,
        avatar_url: null,
        bio: null,
        follower_count: null,
        copier_count: null,
        aum: null,
        tags: [],
      }
    }

    return {
      trader_key: traderKey,
      display_name: portfolio.nickName || portfolio.nickname || null,
      avatar_url: portfolio.userPhotoUrl || portfolio.avatar || null,
      bio: portfolio.introduction || portfolio.bio || null,
      follower_count: portfolio.followerCount ?? null,
      copier_count: portfolio.copierCount ?? portfolio.currentCopyCount ?? null,
      aum: portfolio.totalAssets ? parseFloat(portfolio.totalAssets) : null,
      tags: this.extractTags(portfolio),
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: SnapshotWindow): Promise<ConnectorSnapshot> {
    await this.rateLimiter.acquire()

    const period = WINDOW_TO_PERIOD[window]

    const data = await this.circuitBreaker.execute(() =>
      this.apiRequest(`${BINANCE_COPY_TRADE_V2}/lead-portfolio/query-portfolio`, {
        portfolioId: traderKey,
        timeRange: period,
      })
    )

    const portfolio = data?.data
    const roi = this.parseNumber(portfolio?.roi ?? portfolio?.roiList?.[period])
    const pnl = this.parseNumber(portfolio?.pnl ?? portfolio?.totalPnl)
    const winRate = this.parseNumber(portfolio?.winRate)
    const maxDrawdown = this.parseNumber(portfolio?.maxDrawdown ?? portfolio?.mdd)

    const metrics: SnapshotMetrics = {
      roi: roi ?? 0,
      pnl: pnl ?? 0,
      win_rate: winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null,
      max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
      trades_count: portfolio?.tradeCount ?? portfolio?.totalTradeCount ?? null,
      followers: portfolio?.followerCount ?? null,
      aum: portfolio?.totalAssets ? parseFloat(portfolio.totalAssets) : null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
      rank: null,
    }

    // Calculate arena score
    const scoreResult = calculateArenaScore(
      {
        roi: metrics.roi,
        pnl: metrics.pnl,
        maxDrawdown: metrics.max_drawdown,
        winRate: metrics.win_rate,
      },
      window as Period
    )
    metrics.arena_score = scoreResult.totalScore
    metrics.return_score = scoreResult.returnScore
    metrics.drawdown_score = scoreResult.drawdownScore
    metrics.stability_score = scoreResult.stabilityScore

    const dataCompleteness = [
      metrics.roi !== 0,
      metrics.pnl !== 0,
      metrics.win_rate != null,
      metrics.max_drawdown != null,
      metrics.trades_count != null,
    ].filter(Boolean).length / 5

    return {
      trader_key: traderKey,
      window,
      metrics,
      quality_flags: {
        is_suspicious: false,
        suspicion_reasons: [],
        data_completeness: dataCompleteness,
      },
    }
  }

  async fetchTimeseries(traderKey: string): Promise<ConnectorTimeseries[]> {
    await this.rateLimiter.acquire()

    const results: ConnectorTimeseries[] = []

    try {
      const data = await this.circuitBreaker.execute(() =>
        this.apiRequest(`${BINANCE_COPY_TRADE_V2}/lead-portfolio/query-performance`, {
          portfolioId: traderKey,
          timeRange: 'QUARTERLY',
        })
      )

      const performanceList = data?.data?.performanceRetList || data?.data?.chartData || []
      if (Array.isArray(performanceList) && performanceList.length > 0) {
        const equityCurve: EquityCurvePoint[] = performanceList.map((point: BinanceApiResponse) => ({
          date: new Date(point.time as number || point.date as number || Date.now()).toISOString().split('T')[0],
          roi: this.parseNumber(point.value ?? point.roi) ?? 0,
          pnl: this.parseNumber(point.pnl) ?? 0,
        }))

        results.push({
          trader_key: traderKey,
          series_type: 'equity_curve',
          data: equityCurve,
        })
      }
    } catch {
      // Timeseries is optional, don't fail the whole request
    }

    return results
  }

  // ============================================
  // Private helpers
  // ============================================

  private async apiRequest(url: string, body: Record<string, unknown>): Promise<BinanceApiResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/en/copy-trading',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status} ${response.statusText}`)
      }

      const json = await response.json() as BinanceApiResponse

      // Binance returns code '000000' for success
      if (json.code && json.code !== '000000' && json.code !== 0) {
        throw new Error(`Binance API error code: ${json.code} - ${json.message || 'Unknown error'}`)
      }

      return json
    } finally {
      clearTimeout(timeout)
    }
  }

  private parseLeaderboardEntry(item: BinanceApiResponse, rank: number): LeaderboardEntry | null {
    const traderId = item.portfolioId || item.leadPortfolioId || item.encryptedUid
    if (!traderId) return null

    const roi = this.parseNumber(item.roi ?? item.roiValue)
    if (roi == null) return null

    const winRate = this.parseNumber(item.winRate)

    return {
      trader_key: String(traderId),
      display_name: (item.nickName || item.nickname || null) as string | null,
      avatar_url: (item.userPhotoUrl || item.avatar || null) as string | null,
      roi,
      pnl: this.parseNumber(item.pnl ?? item.totalPnl) ?? 0,
      win_rate: winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null,
      max_drawdown: this.parseNumber(item.maxDrawdown ?? item.mdd) ?? null,
      trades_count: (item.tradeCount ?? item.totalTradeCount ?? null) as number | null,
      followers: (item.followerCount ?? item.currentCopyCount ?? null) as number | null,
      aum: item.totalAssets ? parseFloat(String(item.totalAssets)) : null,
      rank,
    }
  }

  private extractTags(portfolio: BinanceApiResponse): string[] {
    const tags: string[] = []
    if (portfolio.badges && Array.isArray(portfolio.badges)) {
      for (const badge of portfolio.badges) {
        if (typeof badge === 'string') tags.push(badge)
        else if (badge?.name) tags.push(String(badge.name))
      }
    }
    if (portfolio.tradeType) tags.push(String(portfolio.tradeType))
    return tags
  }

  private parseNumber(value: unknown): number | null {
    if (value == null) return null
    const num = typeof value === 'string' ? parseFloat(value) : Number(value)
    return isNaN(num) ? null : num
  }
}
