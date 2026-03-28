/**
 * MEXC Futures Scraper
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, number> = { '7d': 1, '30d': 2, '90d': 3 }

export class MexcFuturesScraper implements PlatformScraper {
  readonly platform = 'mexc'

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
    const timeType = WINDOW_MAP[window]
    const pageSize = 100
    const maxPages = 20
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://futures.mexc.com/api/v1/private/account/assets/copy-trading/trader/list?page=${page}&pageSize=${pageSize}&sortField=yield&sortType=DESC&timeType=${timeType}`

      try {
        const response = await fetch(url, { method: 'GET' })
        if (!response.ok) break

        const data = await response.json()
        const dataObj = data?.data || {}
        const list = dataObj?.list || dataObj?.comprehensives || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: item.uid || '',
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 2000) break
        await this.delay(300)
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

registerScraper('mexc', async () => new MexcFuturesScraper())
registerScraper('mexc_futures', async () => new MexcFuturesScraper())
