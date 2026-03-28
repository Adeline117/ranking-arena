/**
 * Bitunix Futures Scraper
 *
 * Uses Bitunix's copy trading API.
 * API: POST https://api.bitunix.com/copy/trading/v1/trader/list
 * Note: All metrics in decimal format (0.05 = 5%)
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class BitunixFuturesScraper implements PlatformScraper {
  readonly platform = 'bitunix'

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
    const pageSize = 200
    const maxPages = 10
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      try {
        const response = await fetch('https://api.bitunix.com/copy/trading/v1/trader/list', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          body: JSON.stringify({
            pageNo: page,
            pageSize,
          }),
        })

        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.records || data?.data?.list || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.uid || ''),
            raw_data: {
              uid: item.uid,
              nickname: item.nickname,
              header: item.header,
              roi: item.roi,
              pl: item.pl,
              winRate: item.winRate,
              mdd: item.mdd,
              currentFollow: item.currentFollow,
              aum: item.aum,
              winCount: item.winCount,
            },
          })
        }

        if (list.length < pageSize) break
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

registerScraper('bitunix', async () => new BitunixFuturesScraper())
registerScraper('bitunix_futures', async () => new BitunixFuturesScraper())
