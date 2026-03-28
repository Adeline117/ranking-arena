/**
 * dYdX v4 Scraper
 *
 * 职责：纯采集，只负责 HTTP 调用和返回原始 API 响应
 *
 * 数据来源:
 * - Indexer API: indexer.dydx.trade/v4/leaderboard/pnl
 *
 * 注意事项:
 * - 可能有地理限制，使用 DYDX_PROXY_URL 代理
 * - 排行榜按 PnL 排序（不是 ROI）
 * - ROI 需要计算（由 Normalizer 处理）
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, string> = {
  '7d': 'PERIOD_7D',
  '30d': 'PERIOD_30D',
  '90d': 'PERIOD_90D',
}

export class DydxScraper implements PlatformScraper {
  readonly platform = 'dydx'

  private getBaseUrl(): string {
    return process.env.DYDX_PROXY_URL || 'https://indexer.dydx.trade'
  }

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const results: RawFetchResult[] = []

    for (const window of windows) {
      try {
        const result = await this.fetchWindow(window)
        results.push(result)
      } catch (error) {
        results.push({
          platform: this.platform,
          market_type: 'perp',
          window,
          raw_traders: [],
          total_available: 0,
          fetched_at: new Date(),
          api_latency_ms: 0,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return results
  }

  private async fetchWindow(window: TimeWindow): Promise<RawFetchResult> {
    const startTime = Date.now()
    const period = WINDOW_MAP[window]
    const limit = 500
    const allTraders: RawTraderEntry[] = []

    // dYdX uses cursor-based pagination
    let startingBefore: string | null = null

    for (let page = 0; page < 4; page++) {
      // Max 4 pages = 2000 traders
      let url = `${this.getBaseUrl()}/v4/leaderboard/pnl?period=${period}&limit=${limit}`
      if (startingBefore) {
        url += `&startingBeforeOrAt=${startingBefore}`
      }

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })

        if (!response.ok) {
          console.warn(`[DydxScraper] HTTP ${response.status}`)
          break
        }

        const data = await response.json()
        const rankings = data?.leaderboardRankings || []

        if (!Array.isArray(rankings) || rankings.length === 0) break

        for (const item of rankings) {
          allTraders.push({
            trader_id: item.address || '',
            raw_data: {
              address: item.address,
              pnl: item.pnl,
              equity: item.equity,
              rank: item.rank,
              period: item.period,
            },
          })
        }

        // Get cursor for next page
        if (rankings.length < limit) break
        const lastItem = rankings[rankings.length - 1]
        startingBefore = lastItem?.pnl || null
        if (!startingBefore) break

        await this.delay(100)
      } catch (error) {
        console.warn(`[DydxScraper] Page ${page} failed:`, error)
        break
      }
    }

    return {
      platform: this.platform,
      market_type: 'perp',
      window,
      raw_traders: allTraders,
      total_available: allTraders.length,
      fetched_at: new Date(),
      api_latency_ms: Date.now() - startTime,
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

registerScraper('dydx', async () => new DydxScraper())

export function getDydxScraper(): PlatformScraper {
  return new DydxScraper()
}
