/**
 * Bybit Futures Scraper
 *
 * 职责：纯采集
 *
 * 数据来源:
 * - API: api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list
 *
 * 注意事项:
 * - API 有地理限制，可能需要 VPS 代理
 * - 每页最多 100 条
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('scraper:bybit-futures')

const WINDOW_MAP: Record<TimeWindow, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
}

export class BybitFuturesScraper implements PlatformScraper {
  readonly platform = 'bybit'
  private readonly VPS_PROXY_URL = process.env.VPS_PROXY_URL

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const results: RawFetchResult[] = []

    for (const window of windows) {
      try {
        const result = await this.fetchWindow(window)
        results.push(result)
      } catch (error) {
        results.push({
          platform: this.platform,
          market_type: 'futures',
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
    const timeRange = WINDOW_MAP[window]
    const pageSize = 100
    const maxPages = 20
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://api2.bybit.com/fapi/beehive/public/v1/common/dynamic-leader-list?timeRange=${timeRange}&dataType=DATA_ROI&page=${page}&pageSize=${pageSize}`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        })

        if (!response.ok) {
          log.warn(`HTTP ${response.status}`)
          break
        }

        const data = await response.json()

        if (data.retCode !== 0) {
          log.warn(`API error: ${data.retMsg}`)
          break
        }

        const result = data?.result || {}
        const list = result?.leaderDetails || result?.data || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: item.leaderMark || item.leaderId || '',
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 2000) break

        await this.delay(200)
      } catch (error) {
        log.warn(`Page ${page} failed`, { error: error instanceof Error ? error.message : String(error) })
        break
      }
    }

    return {
      platform: this.platform,
      market_type: 'futures',
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

registerScraper('bybit', async () => new BybitFuturesScraper())

export function getBybitFuturesScraper(): PlatformScraper {
  return new BybitFuturesScraper()
}
