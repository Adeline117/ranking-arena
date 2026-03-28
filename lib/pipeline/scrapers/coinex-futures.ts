/**
 * CoinEx Futures Scraper
 *
 * Uses CoinEx's copy trading public API.
 * API: https://www.coinex.com/res/copy-trading/public/traders
 * Note: CoinEx does NOT support 90d window.
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class CoinexFuturesScraper implements PlatformScraper {
  readonly platform = 'coinex'

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

    // CoinEx does not support 90d
    if (window === '90d') {
      return {
        platform: this.platform,
        market_type: 'futures',
        window,
        raw_traders: [],
        total_available: 0,
        fetched_at: new Date(),
        api_latency_ms: 0,
        error: 'CoinEx does not support 90d window',
      }
    }

    const allTraders: RawTraderEntry[] = []
    let currentPage = 1
    const limit = 100
    const maxPages = 10

    while (currentPage <= maxPages) {
      const url = `https://www.coinex.com/res/copy-trading/public/traders?page=${currentPage}&limit=${limit}&sort_by=roi&period=${window}`

      try {
        const response = await fetch(url, { method: 'GET' })
        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.items || data?.data?.data || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.trader_id || ''),
            raw_data: item,
          })
        }

        // Check if there are more pages
        const hasNext = data?.data?.has_next ?? (list.length >= limit)
        if (!hasNext) break
        if (allTraders.length >= 2000) break

        currentPage++
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

registerScraper('coinex', async () => new CoinexFuturesScraper())
