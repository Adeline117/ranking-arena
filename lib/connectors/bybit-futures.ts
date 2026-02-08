/**
 * Bybit Futures Copy Trading Connector
 *
 * Uses Bybit's internal copy-trading API (api2.bybit.com/fapi/beehive).
 * This is an undocumented API reverse-engineered from the Bybit frontend.
 *
 * Endpoints discovered via XHR interception (see scripts/import/import_bybit.mjs).
 * Response structure: { retCode: 0, result: { list: [...] } }
 *
 * Field normalization:
 * - ROI: returned as decimal (0.25 = 25%), multiply by 100
 * - winRate: returned as decimal (0-1), multiply by 100
 * - mdd: returned as decimal (0-1), multiply by 100, take absolute
 */

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

// Bybit internal API base URLs
const BYBIT_API_BASE = 'https://api2.bybit.com/fapi/beehive/public/v1/common'

// Time window mapping
const WINDOW_TO_TIME_RANGE: Record<SnapshotWindow, string> = {
  '7D': 'WEEKLY',
  '30D': 'MONTHLY',
  '90D': 'QUARTERLY',
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
]

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

// External API response type - loosely typed since Bybit internal API shapes vary
 
type BybitApiResponse = Record<string, any>

export class BybitFuturesConnector {
  readonly platform = 'bybit' as const

  private rateLimiter = new DelayRateLimiter(2500)
  private circuitBreaker = new SimpleCircuitBreaker(5, 60000)

  async discoverLeaderboard(window: SnapshotWindow, limit = 50): Promise<LeaderboardEntry[]> {
    const timeRange = WINDOW_TO_TIME_RANGE[window]
    const entries: LeaderboardEntry[] = []
    const pageSize = Math.min(limit, 20)
    const maxPages = Math.ceil(limit / pageSize)

    for (let page = 1; page <= maxPages && entries.length < limit; page++) {
      await this.rateLimiter.acquire()

      const data = await this.circuitBreaker.execute(() =>
        this.apiRequest(`${BYBIT_API_BASE}/dynamic-leader-list`, {
          pageNo: page,
          pageSize,
          timeRange,
          dataType: 'ROI',
          sortField: 'ROI',
          sortType: 'DESC',
        })
      )

      const list = data?.result?.list || data?.data?.list || []
      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list) {
        if (entries.length >= limit) break

        const entry = this.parseLeaderboardEntry(item, entries.length + 1)
        if (entry) {
          entries.push(entry)
        }
      }
    }

    return entries
  }

  async fetchTraderProfile(traderKey: string): Promise<ConnectorTraderProfile> {
    await this.rateLimiter.acquire()

    const data = await this.circuitBreaker.execute(() =>
      this.apiRequest(`${BYBIT_API_BASE}/leader-detail`, {
        leaderId: traderKey,
      })
    )

    const detail = data?.result || data?.data
    if (!detail) {
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
      display_name: detail.nickName || detail.leaderName || null,
      avatar_url: detail.avatar || detail.avatarUrl || null,
      bio: detail.introduction || detail.bio || null,
      follower_count: this.safeInt(detail.followerCount) ?? null,
      copier_count: this.safeInt(detail.copierNum ?? detail.copierCount) ?? null,
      aum: detail.totalAssets ? parseFloat(detail.totalAssets) : null,
      tags: this.extractTags(detail),
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: SnapshotWindow): Promise<ConnectorSnapshot> {
    await this.rateLimiter.acquire()

    const timeRange = WINDOW_TO_TIME_RANGE[window]

    const data = await this.circuitBreaker.execute(() =>
      this.apiRequest(`${BYBIT_API_BASE}/leader-detail`, {
        leaderId: traderKey,
        timeRange,
      })
    )

    const detail = data?.result || data?.data
    if (!detail) {
      return this.emptySnapshot(traderKey, window)
    }

    const roi = this.normalizeRoi(detail.roi ?? detail.roiRate)
    const pnl = this.parseNum(detail.pnl ?? detail.totalPnl) ?? 0
    const winRate = this.normalizeWinRate(detail.winRate)
    const maxDrawdown = this.normalizeMdd(detail.mdd ?? detail.maxDrawdown)

    const metrics: SnapshotMetrics = {
      roi: roi ?? 0,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: this.safeInt(detail.totalTrades ?? detail.tradeCount) ?? null,
      followers: this.safeInt(detail.followerCount) ?? null,
      aum: detail.totalAssets ? parseFloat(detail.totalAssets) : null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
      rank: null,
    }

    // Calculate arena score
    const arenaScore = this.calculateArenaScore(metrics, window)
    metrics.arena_score = arenaScore.total
    metrics.return_score = arenaScore.returnScore
    metrics.drawdown_score = arenaScore.drawdownScore
    metrics.stability_score = arenaScore.stabilityScore

    const completeness = [
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
        data_completeness: completeness,
      },
    }
  }

  async fetchTimeseries(traderKey: string): Promise<ConnectorTimeseries[]> {
    await this.rateLimiter.acquire()

    const results: ConnectorTimeseries[] = []

    try {
      const data = await this.circuitBreaker.execute(() =>
        this.apiRequest(`${BYBIT_API_BASE}/leader-performance`, {
          leaderId: traderKey,
          timeRange: 'QUARTERLY',
        })
      )

      const performanceList = data?.result?.performanceList ||
        data?.result?.list ||
        data?.data?.performanceList ||
        []

      if (Array.isArray(performanceList) && performanceList.length > 0) {
        const equityCurve: EquityCurvePoint[] = performanceList.map((point: BybitApiResponse) => ({
          date: new Date(
            point.time as number || point.date as number || point.timestamp as number || Date.now()
          ).toISOString().split('T')[0],
          roi: this.normalizeRoi(point.roi ?? point.value) ?? 0,
          pnl: this.parseNum(point.pnl ?? point.profit) ?? 0,
        }))

        results.push({
          trader_key: traderKey,
          series_type: 'equity_curve',
          data: equityCurve,
        })
      }
    } catch {
      // Timeseries is optional - failure here is not critical
    }

    return results
  }

  // ============================================
  // Private Helpers
  // ============================================

  private async apiRequest(url: string, body: Record<string, unknown>): Promise<BybitApiResponse> {
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
          'Origin': 'https://www.bybit.com',
          'Referer': 'https://www.bybit.com/copyTrade/tradeCenter/leaderBoard',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const json = await response.json() as BybitApiResponse

      // Bybit uses retCode: 0 for success
      if (json.retCode !== undefined && json.retCode !== 0) {
        throw new Error(`Bybit API error ${json.retCode}: ${json.retMsg || 'Unknown'}`)
      }

      return json
    } finally {
      clearTimeout(timeout)
    }
  }

  private parseLeaderboardEntry(item: BybitApiResponse, rank: number): LeaderboardEntry | null {
    const traderKey = String(item.leaderId || item.traderUid || item.uid || '')
    if (!traderKey) return null

    return {
      trader_key: traderKey,
      display_name: item.nickName || item.leaderName || null,
      avatar_url: item.avatar || item.avatarUrl || null,
      roi: this.normalizeRoi(item.roi ?? item.roiRate) ?? 0,
      pnl: this.parseNum(item.pnl ?? item.totalPnl) ?? 0,
      win_rate: this.normalizeWinRate(item.winRate),
      max_drawdown: this.normalizeMdd(item.mdd ?? item.maxDrawdown),
      trades_count: this.safeInt(item.totalTrades ?? item.tradeCount) ?? null,
      followers: this.safeInt(item.followerCount ?? item.copierNum) ?? null,
      aum: item.totalAssets ? parseFloat(item.totalAssets) : null,
      rank,
    }
  }

  /**
   * Normalize ROI from Bybit format.
   * Bybit may return as decimal (0.25 = 25%) or as percentage (25 = 25%).
   * Heuristic: if absolute value < 10, treat as decimal and multiply by 100.
   */
  private normalizeRoi(value: unknown): number | null {
    const num = this.parseNum(value)
    if (num == null) return null
    // Bybit typically returns ROI as decimal (e.g., 0.25 for 25%)
    if (Math.abs(num) < 10 && Math.abs(num) > 0) {
      return num * 100
    }
    return num
  }

  /**
   * Normalize win rate from Bybit format.
   * Returns as 0-100 percentage.
   */
  private normalizeWinRate(value: unknown): number | null {
    const num = this.parseNum(value)
    if (num == null) return null
    // If 0-1, multiply by 100
    if (num > 0 && num <= 1) {
      return num * 100
    }
    return num
  }

  /**
   * Normalize max drawdown from Bybit format.
   * Returns as positive percentage.
   */
  private normalizeMdd(value: unknown): number | null {
    const num = this.parseNum(value)
    if (num == null) return null
    let mdd = Math.abs(num)
    // If 0-1, multiply by 100
    if (mdd > 0 && mdd <= 1) {
      mdd = mdd * 100
    }
    return mdd
  }

  private parseNum(value: unknown): number | null {
    if (value == null) return null
    const n = typeof value === 'string' ? parseFloat(value) : Number(value)
    return isNaN(n) ? null : n
  }

  private safeInt(value: unknown): number | null {
    if (value == null) return null
    const n = typeof value === 'string' ? parseInt(value, 10) : Number(value)
    return isNaN(n) ? null : Math.floor(n)
  }

  private extractTags(detail: BybitApiResponse): string[] {
    const tags: string[] = []
    if (Array.isArray(detail.badges)) {
      for (const b of detail.badges) {
        if (typeof b === 'string') tags.push(b)
        else if (b?.name) tags.push(String(b.name))
      }
    }
    if (Array.isArray(detail.tags)) {
      for (const t of detail.tags) {
        if (typeof t === 'string') tags.push(t)
        else if (t?.name) tags.push(String(t.name))
      }
    }
    return tags
  }

  private emptySnapshot(traderKey: string, window: SnapshotWindow): ConnectorSnapshot {
    return {
      trader_key: traderKey,
      window,
      metrics: {
        roi: 0,
        pnl: 0,
        win_rate: null,
        max_drawdown: null,
        trades_count: null,
        followers: null,
        aum: null,
        arena_score: null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
        rank: null,
      },
      quality_flags: {
        is_suspicious: false,
        suspicion_reasons: [],
        data_completeness: 0,
      },
    }
  }

  /**
   * Simplified Arena Score calculation (matches lib/utils/arena-score.ts logic)
   */
  private calculateArenaScore(
    metrics: SnapshotMetrics,
    window: SnapshotWindow
  ): { total: number; returnScore: number; drawdownScore: number; stabilityScore: number } {
    const roi = metrics.roi
    let returnScore: number
    if (roi <= 0) returnScore = 0
    else if (roi < 50) returnScore = (roi / 50) * 30
    else if (roi < 200) returnScore = 30 + ((roi - 50) / 150) * 25
    else if (roi < 1000) returnScore = 55 + ((roi - 200) / 800) * 20
    else returnScore = 75 + Math.min((roi - 1000) / 5000, 1) * 10
    returnScore = Math.min(returnScore, 85)

    const mdd = Math.abs(metrics.max_drawdown ?? 100)
    let drawdownScore: number
    if (mdd <= 5) drawdownScore = 8
    else if (mdd <= 10) drawdownScore = 7
    else if (mdd <= 20) drawdownScore = 5
    else if (mdd <= 40) drawdownScore = 3
    else if (mdd <= 60) drawdownScore = 1
    else drawdownScore = 0

    const winRate = metrics.win_rate ?? 50
    let stabilityScore: number
    if (winRate >= 80) stabilityScore = 7
    else if (winRate >= 70) stabilityScore = 6
    else if (winRate >= 60) stabilityScore = 5
    else if (winRate >= 50) stabilityScore = 3
    else if (winRate >= 40) stabilityScore = 2
    else stabilityScore = 0

    const total = Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
    return { total, returnScore, drawdownScore, stabilityScore }
  }
}
