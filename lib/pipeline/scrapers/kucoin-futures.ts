/**
 * KuCoin Futures Scraper
 *
 * Uses KuCoin's copy trading API.
 * Note: KuCoin is CF-protected, may require VPS/proxy in production
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, string> = { '7d': 'SEVEN_DAY', '30d': 'THIRTY_DAY', '90d': 'NINETY_DAY' }

export class KucoinFuturesScraper implements PlatformScraper {
  readonly platform = 'kucoin'

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
    const maxPages = 10
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      // Try new API first
      let url = `https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/rn/leaderboard/query?lang=en_US&pageNo=${page}&pageSize=${pageSize}`

      try {
        let response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
        })

        // If new API fails, try legacy API
        if (!response.ok) {
          url = `https://www.kucoin.com/_api/copy-trade/leader/public/list?pageNo=${page}&pageSize=${pageSize}&orderBy=ROI&period=${WINDOW_MAP[window]}`
          response = await fetch(url, { method: 'GET' })
        }

        if (!response.ok) {
          if (page === 1) {
            return {
              platform: this.platform,
              market_type: 'futures',
              window,
              raw_traders: [],
              total_available: 0,
              fetched_at: new Date(),
              api_latency_ms: Date.now() - startTime,
              error: 'KuCoin API blocked (CF protection) - requires VPS proxy',
            }
          }
          break
        }

        const data = await response.json()
        const dataObj = data?.data || data
        const list = dataObj?.items || dataObj?.list || dataObj?.rows || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.leadConfigId || item.uid || ''),
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 500) break
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

registerScraper('kucoin', async () => new KucoinFuturesScraper())
registerScraper('kucoin_futures', async () => new KucoinFuturesScraper())
