/**
 * MEXC Futures Scraper
 *
 * Uses VPS Playwright scraper to bypass CloudFlare protection.
 * VPS Endpoint: /mexc/leaderboard on port 3457
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class MexcFuturesScraper implements PlatformScraper {
  readonly platform = 'mexc'

  private get VPS_SCRAPER_URL(): string | undefined {
    return process.env.VPS_SCRAPER_SG || process.env.VPS_PROXY_SG?.replace(':3456', ':3457')
  }

  private get VPS_PROXY_KEY(): string | undefined {
    return process.env.VPS_PROXY_KEY?.trim()
  }

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

    // Check VPS configuration
    if (!this.VPS_SCRAPER_URL || !this.VPS_PROXY_KEY) {
      return {
        platform: this.platform,
        market_type: 'futures',
        window,
        raw_traders: [],
        total_available: 0,
        fetched_at: new Date(),
        api_latency_ms: 0,
        error: 'MEXC requires VPS scraper - VPS_SCRAPER_SG and VPS_PROXY_KEY not configured',
      }
    }

    const allTraders: RawTraderEntry[] = []

    try {
      // Use VPS Playwright scraper
      const url = `${this.VPS_SCRAPER_URL}/mexc/leaderboard?pageNo=1&pageSize=100`
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Proxy-Key': this.VPS_PROXY_KEY,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(120000),
      })

      if (!response.ok) {
        throw new Error(`VPS scraper returned ${response.status}`)
      }

      const data = await response.json()

      // Handle MEXC response format
      const list = data?.data?.comprehensives || data?.data?.list || []

      if (Array.isArray(list)) {
        for (const item of list) {
          allTraders.push({
            trader_id: String(item.uid || ''),
            raw_data: {
              uid: item.uid,
              nickname: item.nickname,
              avatar: item.avatar,
              roi: item.roi,
              pnl: item.pnl || item.totalPnl,
              winRate: item.winRate,
              followers: item.followers,
              followable: item.followable,
              equity: item.equity,
              totalRoi: item.totalRoi,
              totalWinRate: item.totalWinRate,
              order: item.order,
            },
          })
        }
      }
    } catch (error) {
      return {
        platform: this.platform,
        market_type: 'futures',
        window,
        raw_traders: [],
        total_available: 0,
        fetched_at: new Date(),
        api_latency_ms: Date.now() - startTime,
        error: `VPS scraper error: ${error instanceof Error ? error.message : String(error)}`,
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
}

registerScraper('mexc', async () => new MexcFuturesScraper())
registerScraper('mexc_futures', async () => new MexcFuturesScraper())
