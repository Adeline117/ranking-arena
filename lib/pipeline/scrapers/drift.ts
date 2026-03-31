/**
 * Drift Protocol Scraper
 *
 * 职责：纯采集
 *
 * 数据来源:
 * - API: https://data.api.drift.trade/stats/leaderboard
 *
 * 注意事项:
 * - 公开 API，无需认证
 * - 每页最多 100 条，最多 500 个 trader
 * - 支持日期范围过滤
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('scraper:drift')

export class DriftScraper implements PlatformScraper {
  readonly platform = 'drift'

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
    const pageSize = 100
    const maxPages = 5 // Max 500 traders
    const allTraders: RawTraderEntry[] = []

    // Build date range
    const now = new Date()
    const days = window === '7d' ? 7 : window === '30d' ? 30 : 90
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]
    const endDate = now.toISOString().split('T')[0]

    for (let page = 1; page <= maxPages; page++) {
      let url = `https://data.api.drift.trade/stats/leaderboard?page=${page}&limit=${pageSize}&sort=pnl`
      if (window !== '90d') {
        url += `&startDate=${startDate}&endDate=${endDate}`
      }

      try {
        const response = await fetch(url, { method: 'GET' })
        if (!response.ok) break

        const data = await response.json()
        const leaderboard =
          data?.data?.leaderboard || data?.result || data?.data || []

        if (!Array.isArray(leaderboard) || leaderboard.length === 0) break

        for (const item of leaderboard) {
          allTraders.push({
            trader_id: item.authority || '',
            raw_data: {
              authority: item.authority,
              pnl: item.pnl,
              volume: item.volume,
              rank: item.rank,
            },
          })
        }

        if (leaderboard.length < pageSize) break
        await this.delay(100)
      } catch (error) {
        log.warn(`Page ${page} failed`, { error: error instanceof Error ? error.message : String(error) })
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

registerScraper('drift', async () => new DriftScraper())

export function getDriftScraper(): PlatformScraper {
  return new DriftScraper()
}
