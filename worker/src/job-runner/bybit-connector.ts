/**
 * Bybit Futures Connector for Job Runner
 * Self-contained (no @/ path aliases) for standalone worker execution.
 *
 * Uses Bybit's internal copy-trading API (api2.bybit.com/fapi/beehive).
 */

import type {
  ConnectorInterface,
  ConnectorTraderProfile,
  ConnectorSnapshot,
  ConnectorTimeseries,
  SnapshotWindow,
  SnapshotMetrics,
} from './types.js'
import { logger } from '../logger.js'

const BYBIT_API_BASE = 'https://api2.bybit.com/fapi/beehive/public/v1/common'

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

 
type BybitApiResponse = Record<string, any>

// Simple delay-based rate limiter
let lastRequestTime = 0
const MIN_DELAY_MS = 2500

async function rateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < MIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed + Math.random() * 500))
  }
  lastRequestTime = Date.now()
}

export class BybitFuturesConnectorWorker implements ConnectorInterface {

  async fetchTraderProfile(traderKey: string): Promise<ConnectorTraderProfile | null> {
    await rateLimit()

    const data = await this.apiRequest(`${BYBIT_API_BASE}/leader-detail`, {
      leaderId: traderKey,
    })

    const detail = data?.result || data?.data
    if (!detail) return null

    return {
      trader_key: traderKey,
      display_name: detail.nickName || detail.leaderName || null,
      avatar_url: detail.avatar || detail.avatarUrl || null,
      bio: detail.introduction || detail.bio || null,
      follower_count: detail.followerCount ?? null,
      copier_count: detail.copierNum ?? detail.copierCount ?? null,
      aum: detail.totalAssets ? parseFloat(detail.totalAssets) : null,
      tags: this.extractTags(detail),
    }
  }

  async fetchTraderSnapshot(traderKey: string, window: SnapshotWindow): Promise<ConnectorSnapshot | null> {
    await rateLimit()

    const timeRange = WINDOW_TO_TIME_RANGE[window]

    const data = await this.apiRequest(`${BYBIT_API_BASE}/leader-detail`, {
      leaderId: traderKey,
      timeRange,
    })

    const detail = data?.result || data?.data
    if (!detail) return null

    const roi = this.normalizeRoi(detail.roi ?? detail.roiRate)
    const pnl = this.parseNum(detail.pnl ?? detail.totalPnl) ?? 0
    const winRate = this.normalizeWinRate(detail.winRate)
    const maxDrawdown = this.normalizeMdd(detail.mdd ?? detail.maxDrawdown)

    const metrics: SnapshotMetrics = {
      roi: roi ?? 0,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      trades_count: detail.totalTrades ?? detail.tradeCount ?? null,
      followers: detail.followerCount ?? null,
      aum: detail.totalAssets ? parseFloat(detail.totalAssets) : null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
      rank: null,
    }

    const arenaScore = this.calculateSimpleArenaScore(metrics, window)
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
    await rateLimit()

    const results: ConnectorTimeseries[] = []

    try {
      const data = await this.apiRequest(`${BYBIT_API_BASE}/leader-performance`, {
        leaderId: traderKey,
        timeRange: 'QUARTERLY',
      })

      const performanceList = data?.result?.performanceList ||
        data?.result?.list ||
        data?.data?.performanceList ||
        []

      if (Array.isArray(performanceList) && performanceList.length > 0) {
        const equityCurve = performanceList.map((point: BybitApiResponse) => ({
          date: new Date(point.time as number || point.date as number || Date.now()).toISOString().split('T')[0],
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
      // Timeseries is optional
    }

    return results
  }

  /**
   * Fetch leaderboard list (used by discover-leaderboard script)
   */
  async fetchLeaderboardList(window: SnapshotWindow, limit: number): Promise<LeaderboardResult[]> {
    const timeRange = WINDOW_TO_TIME_RANGE[window]
    const results: LeaderboardResult[] = []
    const pageSize = Math.min(limit, 20)
    const maxPages = Math.ceil(limit / pageSize)

    for (let page = 1; page <= maxPages && results.length < limit; page++) {
      await rateLimit()

      try {
        const data = await this.apiRequest(`${BYBIT_API_BASE}/dynamic-leader-list`, {
          pageNo: page,
          pageSize,
          timeRange,
          dataType: 'ROI',
          sortField: 'ROI',
          sortType: 'DESC',
        })

        const list = data?.result?.list || data?.data?.list || []
        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          if (results.length >= limit) break

          const traderId = String(item.leaderId || item.traderUid || item.uid || '')
          if (!traderId) continue

          const roi = this.normalizeRoi(item.roi ?? item.roiRate) ?? 0
          const pnl = this.parseNum(item.pnl ?? item.totalPnl) ?? 0
          const winRate = this.normalizeWinRate(item.winRate)
          const maxDrawdown = this.normalizeMdd(item.mdd ?? item.maxDrawdown)

          const arenaScore = this.calculateSimpleArenaScore({
            roi,
            pnl,
            win_rate: winRate,
            max_drawdown: maxDrawdown,
            trades_count: null,
            followers: null,
            aum: null,
            arena_score: null,
            return_score: null,
            drawdown_score: null,
            stability_score: null,
            rank: null,
          }, window)

          results.push({
            trader_key: traderId,
            display_name: (item.nickName || item.leaderName || null) as string | null,
            avatar_url: (item.avatar || item.avatarUrl || null) as string | null,
            metrics: {
              roi,
              pnl,
              win_rate: winRate,
              max_drawdown: maxDrawdown,
              trades_count: (item.totalTrades ?? item.tradeCount ?? null) as number | null,
              followers: (item.followerCount ?? item.copierNum ?? null) as number | null,
              aum: item.totalAssets ? parseFloat(String(item.totalAssets)) : null,
              arena_score: arenaScore.total,
              return_score: arenaScore.returnScore,
              drawdown_score: arenaScore.drawdownScore,
              stability_score: arenaScore.stabilityScore,
              rank: results.length + 1,
            },
            quality_flags: {
              is_suspicious: false,
              suspicion_reasons: [],
              data_completeness: [roi !== 0, pnl !== 0, winRate != null, maxDrawdown != null].filter(Boolean).length / 4,
            },
          })
        }
      } catch (err) {
        logger.error(`[bybit] Fetch error page ${page}`, err instanceof Error ? err : new Error(String(err)))
        break
      }
    }

    return results.slice(0, limit)
  }

  // ============================================
  // Private helpers
  // ============================================

  private async apiRequest(url: string, body: Record<string, unknown>): Promise<BybitApiResponse> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
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
      if (json.retCode !== undefined && json.retCode !== 0) {
        throw new Error(`Bybit API error ${json.retCode}: ${json.retMsg || 'Unknown'}`)
      }

      return json
    } finally {
      clearTimeout(timeout)
    }
  }

  private normalizeRoi(value: unknown): number | null {
    const num = this.parseNum(value)
    if (num == null) return null
    if (Math.abs(num) < 10 && Math.abs(num) > 0) {
      return num * 100
    }
    return num
  }

  private normalizeWinRate(value: unknown): number | null {
    const num = this.parseNum(value)
    if (num == null) return null
    if (num > 0 && num <= 1) return num * 100
    return num
  }

  private normalizeMdd(value: unknown): number | null {
    const num = this.parseNum(value)
    if (num == null) return null
    let mdd = Math.abs(num)
    if (mdd > 0 && mdd <= 1) mdd = mdd * 100
    return mdd
  }

  private extractTags(detail: BybitApiResponse): string[] {
    const tags: string[] = []
    if (Array.isArray(detail.badges)) {
      for (const b of detail.badges) {
        if (typeof b === 'string') tags.push(b)
        else if (b?.name) tags.push(String(b.name))
      }
    }
    return tags
  }

  private parseNum(value: unknown): number | null {
    if (value == null) return null
    const n = typeof value === 'string' ? parseFloat(value) : Number(value)
    return isNaN(n) ? null : n
  }

  private calculateSimpleArenaScore(
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

export interface LeaderboardResult {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  metrics: Record<string, unknown>
  quality_flags: Record<string, unknown>
}
