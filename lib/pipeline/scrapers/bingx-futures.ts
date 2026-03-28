/**
 * BingX Futures Scraper
 *
 * Uses VPS Playwright scraper to bypass CloudFlare protection.
 * VPS Endpoint: /bingx/leaderboard on port 3457
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, number> = { '7d': 7, '30d': 30, '90d': 90 }

export class BingxFuturesScraper implements PlatformScraper {
  readonly platform = 'bingx'

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
        error: 'BingX requires VPS scraper - VPS_SCRAPER_SG and VPS_PROXY_KEY not configured',
      }
    }

    const period = WINDOW_MAP[window]
    const allTraders: RawTraderEntry[] = []

    try {
      // Use VPS Playwright scraper
      const url = `${this.VPS_SCRAPER_URL}/bingx/leaderboard?period=${period}&pageSize=100`
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

      // Handle nested format from VPS scraper
      const globalResult = data?.data?.global?.result || data?.data?.list || []

      if (Array.isArray(globalResult)) {
        for (const item of globalResult) {
          // VPS scraper returns nested traderInfoVo format
          const info = item.traderInfoVo || item
          allTraders.push({
            trader_id: String(info.trader || info.apiIdentity || info.uniqueId || ''),
            raw_data: {
              trader: info.trader,
              apiIdentity: info.apiIdentity,
              traderName: info.traderName,
              avatar: info.avatar,
              roi: item.cumulativePnlRate7Days || item.roi,
              pnl: item.totalEarnings || item.pnl,
              followerEarning: item.followerEarning,
              winRate: info.winRate,
              maxDrawdown: info.maxDrawdown,
              followerNum: info.followerNum,
              rank: item.rank,
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

registerScraper('bingx', async () => new BingxFuturesScraper())
registerScraper('bingx_futures', async () => new BingxFuturesScraper())
