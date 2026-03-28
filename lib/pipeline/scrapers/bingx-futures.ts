/**
 * BingX Futures Scraper
 *
 * Uses BingX's copy trading API.
 * API: https://bingx.com/api/uc/v1/public/copyTrade/traders
 * Note: CloudFlare protected - may need VPS proxy in production
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, string> = { '7d': '7', '30d': '30', '90d': '90' }

export class BingxFuturesScraper implements PlatformScraper {
  readonly platform = 'bingx'

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
    const period = WINDOW_MAP[window]
    const pageSize = 100
    const maxPages = 20
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://bingx.com/api/uc/v1/public/copyTrade/traders?page=${page}&pageSize=${pageSize}&period=${period}&sortBy=roi&sortOrder=desc`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Origin': 'https://bingx.com',
            'Referer': 'https://bingx.com/en/CopyTrading/leaderBoard',
          },
        })

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
              error: 'BingX API blocked (CF protection) - requires VPS proxy',
            }
          }
          break
        }

        const data = await response.json()
        const list = data?.data?.list || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.uniqueId || item.uid || item.traderId || ''),
            raw_data: {
              uniqueId: item.uniqueId,
              traderName: item.traderName,
              headUrl: item.headUrl,
              roi: item.roi,
              pnl: item.pnl,
              winRate: item.winRate,
              maxDrawdown: item.maxDrawdown,
              followerNum: item.followerNum,
              copyNum: item.copyNum,
              aum: item.aum,
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

registerScraper('bingx', async () => new BingxFuturesScraper())
registerScraper('bingx_futures', async () => new BingxFuturesScraper())
