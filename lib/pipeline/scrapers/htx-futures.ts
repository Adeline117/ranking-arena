/**
 * HTX (Huobi) Futures Scraper
 *
 * Uses HTX's copy trading ranking API.
 * API: https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

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
    const pageSize = 50
    const maxPages = 20
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank?rankType=1&pageNo=${page}&pageSize=${pageSize}`

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15000)

        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
        })

        clearTimeout(timer)

        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.itemList || data?.data?.list || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.uid || ''),
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
