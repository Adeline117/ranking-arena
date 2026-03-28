/**
 * Gate.io Futures Scraper
 *
 * Uses Gate.io's copy trading leader list API.
 * API: https://www.gate.com/apiw/v2/copy/leader/list
 * Note: Only 'month' cycle works reliably (week/quarter return errors)
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class GateioFuturesScraper implements PlatformScraper {
  readonly platform = 'gateio'

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
    // Gate.io only supports cycle=month reliably
    const cycle = 'month'
    const pageSize = 50
    const maxPages = 15
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://www.gate.com/apiw/v2/copy/leader/list?page=${page}&page_size=${pageSize}&order_by=profit_rate&cycle=${cycle}`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Origin': 'https://www.gate.io',
            'Referer': 'https://www.gate.io/strategybot',
          },
        })

        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.list || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.leader_id || item.uid || item.user_id || ''),
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 750) break
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

registerScraper('gateio', async () => new GateioFuturesScraper())
