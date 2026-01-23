/**
 * Binance Futures Connector for Job Runner
 * Self-contained (no @/ path aliases) for standalone worker execution.
 */

import type {
  ConnectorInterface,
  ConnectorTraderProfile,
  ConnectorSnapshot,
  ConnectorTimeseries,
  SnapshotWindow,
  SnapshotMetrics,
} from './types.js'

const BINANCE_API_V1 = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade'
const BINANCE_API_V2 = 'https://www.binance.com/bapi/futures/v2/friendly/future/copy-trade'

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

// External API response type - loosely typed since Binance API shapes vary per endpoint
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BinanceApiResponse = Record<string, any>

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

export class BinanceFuturesConnectorWorker implements ConnectorInterface {

  async fetchTraderProfile(traderKey: string): Promise<ConnectorTraderProfile | null> {
    await rateLimit()

    const data = await this.apiRequest(`${BINANCE_API_V2}/lead-portfolio/query-portfolio`, {
      portfolioId: traderKey,
    })

    const portfolio = data?.data
    if (!portfolio) return null

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

  async fetchTraderSnapshot(traderKey: string, window: SnapshotWindow): Promise<ConnectorSnapshot | null> {
    await rateLimit()

    const period = WINDOW_TO_PERIOD[window]

    const data = await this.apiRequest(`${BINANCE_API_V2}/lead-portfolio/query-portfolio`, {
      portfolioId: traderKey,
      timeRange: period,
    })

    const portfolio = data?.data
    if (!portfolio) return null

    const roi = this.parseNum(portfolio.roi ?? portfolio.roiList?.[period])
    const pnl = this.parseNum(portfolio.pnl ?? portfolio.totalPnl)
    const winRate = this.parseNum(portfolio.winRate)
    const maxDrawdown = this.parseNum(portfolio.maxDrawdown ?? portfolio.mdd)

    const metrics: SnapshotMetrics = {
      roi: roi ?? 0,
      pnl: pnl ?? 0,
      win_rate: winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null,
      max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
      trades_count: portfolio.tradeCount ?? portfolio.totalTradeCount ?? null,
      followers: portfolio.followerCount ?? null,
      aum: portfolio.totalAssets ? parseFloat(portfolio.totalAssets) : null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
      rank: null,
    }

    // Calculate arena score inline (simplified version)
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
      const data = await this.apiRequest(`${BINANCE_API_V2}/lead-portfolio/query-performance`, {
        portfolioId: traderKey,
        timeRange: 'QUARTERLY',
      })

      const performanceList = data?.data?.performanceRetList || data?.data?.chartData || []
      if (Array.isArray(performanceList) && performanceList.length > 0) {
        const equityCurve = performanceList.map((point: BinanceApiResponse) => ({
          date: new Date(point.time as number || point.date as number || Date.now()).toISOString().split('T')[0],
          roi: this.parseNum(point.value ?? point.roi) ?? 0,
          pnl: this.parseNum(point.pnl) ?? 0,
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

  // ============================================
  // Private
  // ============================================

  private async apiRequest(url: string, body: Record<string, unknown>): Promise<BinanceApiResponse> {
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
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/en/copy-trading',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const json = await response.json() as BinanceApiResponse
      if (json.code && json.code !== '000000' && json.code !== 0) {
        throw new Error(`API error ${json.code}: ${json.message || 'Unknown'}`)
      }

      return json
    } finally {
      clearTimeout(timeout)
    }
  }

  private extractTags(portfolio: BinanceApiResponse): string[] {
    const tags: string[] = []
    if (Array.isArray(portfolio.badges)) {
      for (const b of portfolio.badges) {
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

  /**
   * Simplified Arena Score calculation (matching lib/utils/arena-score.ts logic)
   * Weights: Return 40%, Drawdown 35%, Stability 25%
   */
  private calculateSimpleArenaScore(
    metrics: SnapshotMetrics,
    window: SnapshotWindow
  ): { total: number; returnScore: number; drawdownScore: number; stabilityScore: number } {
    const PNL_THRESHOLDS: Record<SnapshotWindow, number> = { '7D': 50, '30D': 200, '90D': 500 }

    // Check PnL threshold
    if (Math.abs(metrics.pnl) < PNL_THRESHOLDS[window]) {
      return { total: 0, returnScore: 0, drawdownScore: 0, stabilityScore: 0 }
    }

    // Return score (0-85): based on ROI percentile
    const roi = metrics.roi
    let returnScore: number
    if (roi <= 0) returnScore = 0
    else if (roi < 50) returnScore = (roi / 50) * 30
    else if (roi < 200) returnScore = 30 + ((roi - 50) / 150) * 25
    else if (roi < 1000) returnScore = 55 + ((roi - 200) / 800) * 20
    else returnScore = 75 + Math.min((roi - 1000) / 5000, 1) * 10

    returnScore = Math.min(returnScore, 85)

    // Drawdown score (0-8): lower drawdown is better
    const mdd = Math.abs(metrics.max_drawdown ?? 100)
    let drawdownScore: number
    if (mdd <= 5) drawdownScore = 8
    else if (mdd <= 10) drawdownScore = 7
    else if (mdd <= 20) drawdownScore = 5
    else if (mdd <= 40) drawdownScore = 3
    else if (mdd <= 60) drawdownScore = 1
    else drawdownScore = 0

    // Stability score (0-7): based on win rate
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
