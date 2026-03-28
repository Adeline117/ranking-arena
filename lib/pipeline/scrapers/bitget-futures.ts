/**
 * Bitget Futures Scraper
 *
 * 职责：纯采集，只负责 HTTP 调用和返回原始 API 响应
 *
 * 数据来源:
 * - API: www.bitget.com/v1/trigger/trace/public/currentTrader/list
 *
 * 注意事项:
 * - CloudFlare 保护，可能需要 VPS 代理
 * - 每页最多 100 条
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, number> = {
  '7d': 1,
  '30d': 2,
  '90d': 3,
}

export class BitgetFuturesScraper implements PlatformScraper {
  readonly platform = 'bitget_futures'
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
      const url = `https://www.bitget.com/v1/trigger/trace/public/currentTrader/list?pageNo=${page}&pageSize=${pageSize}&sortType=2&timeRange=${timeRange}`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        })

        if (!response.ok) break

        const data = await response.json()
        const dataObj = data?.data || {}
        const list = dataObj?.list || dataObj?.traderList || dataObj?.rows || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: item.traderId || item.traderUid || '',
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 2000) break

        await this.delay(200)
      } catch (error) {
        console.warn(`[BitgetFuturesScraper] Page ${page} failed:`, error)
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

registerScraper('bitget_futures', async () => new BitgetFuturesScraper())

export function getBitgetFuturesScraper(): PlatformScraper {
  return new BitgetFuturesScraper()
}
