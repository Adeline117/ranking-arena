/**
 * Phemex Futures Scraper
 *
 * Phemex copy trading API requires authentication.
 * This scraper is a placeholder until we implement authenticated access.
 * Note: Public API endpoints return 404/10500 errors.
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'
import { logger } from '@/lib/logger'

export class PhemexFuturesScraper implements PlatformScraper {
  readonly platform = 'phemex'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    // Phemex API requires authentication - no public leaderboard endpoint
    return windows.map((window) => ({
      platform: this.platform,
      market_type: 'futures' as const,
      window,
      raw_traders: [],
      total_available: 0,
      fetched_at: new Date(),
      api_latency_ms: 0,
      error: 'Phemex copy trading API requires authentication - no public endpoint available',
    }))
  }

  private async fetchWindow(window: TimeWindow): Promise<RawFetchResult> {
    const startTime = Date.now()
    const pageSize = 20
    const maxPages = 25
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://api.phemex.com/copy-trading/public/traders?page=${page}&pageSize=${pageSize}&sortBy=roi&sortOrder=desc&period=${window}`

      try {
        const response = await fetch(url, { method: 'GET' })

        if (!response.ok) break

        const data = await response.json()
        const list = data?.data?.rows || []

        if (!Array.isArray(list) || list.length === 0) break

        for (const item of list) {
          allTraders.push({
            trader_id: String(item.uid || ''),
            raw_data: {
              uid: item.uid,
              nickname: item.nickname,
              avatar: item.avatar,
              roi: item.roi,
              pnl: item.pnl,
              winRate: item.winRate,
              maxDrawdown: item.maxDrawdown,
              followers: item.followers,
              copiers: item.copiers,
              aum: item.aum,
              tradesCount: item.tradesCount,
            },
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 500) break
        await this.delay(200)
      } catch (err) {
        logger.warn('[scraper-phemex] page fetch fallback:', err instanceof Error ? err.message : String(err))
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

registerScraper('phemex', async () => new PhemexFuturesScraper())
registerScraper('phemex_futures', async () => new PhemexFuturesScraper())
