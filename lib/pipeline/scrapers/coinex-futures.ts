/**
 * CoinEx Futures Scraper
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, number> = { '7d': 7, '30d': 30, '90d': 90 }

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
    const days = WINDOW_MAP[window]
    const limit = 100
    const allTraders: RawTraderEntry[] = []
    let offset = 0

    for (let page = 0; page < 20; page++) {
      const url = `https://www.coinex.com/res/copy/leader/list?offset=${offset}&limit=${limit}&days=${days}&sort=profit_rate&direction=desc`

      try {
        const response = await fetch(url, { method: 'GET' })
        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.list || data?.data || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: item.leader_id || item.uid || '',
            raw_data: item,
          })
        }

        if (list.length < limit) break
        offset += limit
        if (allTraders.length >= 2000) break
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
