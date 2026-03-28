/**
 * HTX (Huobi) Futures Scraper
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, number> = { '7d': 7, '30d': 30, '90d': 90 }

export class HtxFuturesScraper implements PlatformScraper {
  readonly platform = 'htx_futures'

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
    const days = WINDOW_MAP[window]
    const pageSize = 20
    const maxPages = 50
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://futures.htx.com/-/x/hbg/v1/copy/public/trader/list?pageNum=${page}&pageSize=${pageSize}&sort=profit&direction=desc&days=${days}`

      try {
        const response = await fetch(url, { method: 'GET' })
        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.list || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: item.accountId || item.uid || '',
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 1000) break
        await this.delay(200)
      } catch {
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

registerScraper('htx_futures', async () => new HtxFuturesScraper())
