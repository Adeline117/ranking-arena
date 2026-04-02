/**
 * Aevo Scraper
 *
 * 职责：纯采集
 *
 * 数据来源:
 * - API: https://api.aevo.xyz/leaderboard
 *
 * 注意事项:
 * - 公开 API，无需认证
 * - 单次调用返回所有时间段（weekly/monthly/all_time）
 */

import { RawFetchResult, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class AevoScraper implements PlatformScraper {
  readonly platform = 'aevo'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const startTime = Date.now()

    try {
      // Aevo 单次调用返回所有时间段
      const response = await fetch('https://api.aevo.xyz/leaderboard?limit=500', {
        method: 'GET',
      })

      if (!response.ok) {
        throw new Error(`Aevo API returned ${response.status}`)
      }

      const data = await response.json()
      const latency = Date.now() - startTime

      // 解析不同时间段
      const leaderboard = data?.leaderboard || data
      const weeklyData = leaderboard?.weekly || data?.weekly || []
      const monthlyData = leaderboard?.monthly || data?.monthly || []
      const allTimeData = leaderboard?.all_time || data?.all_time || []

      // 为每个请求的窗口创建结果
      return windows.map((window) => {
        const rawData =
          window === '7d'
            ? weeklyData
            : window === '30d'
              ? monthlyData
              : allTimeData

        return {
          platform: this.platform,
          market_type: 'perp' as const,
          window,
          raw_traders: (rawData || []).map(
            (item: Record<string, unknown>) => ({
              trader_id: String(item.username || ''),
              raw_data: {
                username: item.username,
                pnl: item.pnl,
                options_volume: item.options_volume,
                perp_volume: item.perp_volume,
                totalVolume: item.totalVolume,
                ranking: item.ranking,
              },
            })
          ),
          total_available: (rawData || []).length,
          fetched_at: new Date(),
          api_latency_ms: latency,
        }
      })
    } catch (error) {
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: [],
        total_available: 0,
        fetched_at: new Date(),
        api_latency_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
}

registerScraper('aevo', async () => new AevoScraper())

export function getAevoScraper(): PlatformScraper {
  return new AevoScraper()
}
