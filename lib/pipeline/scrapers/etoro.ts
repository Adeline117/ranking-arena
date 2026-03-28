/**
 * eToro Scraper
 *
 * Uses eToro's public rankings API.
 * API: https://www.etoro.com/sapi/rankings/rankings/
 * Note: Filters to crypto traders only (excludes stocks/ETFs/etc)
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, string> = {
  '7d': 'CurrMonth',
  '30d': 'OneMonthAgo',
  '90d': 'ThreeMonthsAgo',
}

// Non-crypto asset classes to filter out
const EXCLUDED_ASSET_CLASSES = new Set([
  'Stocks', 'ETFs', 'Currencies', 'Commodities', 'Indices',
])

export class EtoroScraper implements PlatformScraper {
  readonly platform = 'etoro'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const results: RawFetchResult[] = []

    for (const window of windows) {
      try {
        const result = await this.fetchWindow(window)
        results.push(result)
      } catch (error) {
        results.push({
          platform: this.platform,
          market_type: 'spot',
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
      const url = `https://www.etoro.com/sapi/rankings/rankings/?Period=${period}&page=${page}&pagesize=${pageSize}`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
        })

        if (!response.ok) break

        const data = await response.json()
        const items = data?.Items || []

        if (!Array.isArray(items) || items.length === 0) break

        for (const item of items) {
          // Filter crypto-only traders
          if (EXCLUDED_ASSET_CLASSES.has(item.TopTradedAssetClassName)) continue

          allTraders.push({
            trader_id: String(item.CustomerId || item.UserName || ''),
            raw_data: {
              customerId: item.CustomerId,
              userName: item.UserName,
              gain: item.Gain,          // ROI percentage
              winRatio: item.WinRatio,
              peakToValley: item.PeakToValley,  // Negative MDD
              copiers: item.Copiers,
              aumValue: item.AUMValue,
              riskScore: item.RiskScore,
              topTradedAssetClassName: item.TopTradedAssetClassName,
              dailyDD: item.DailyDD,
              weeklyDD: item.WeeklyDD,
            },
          })
        }

        if (items.length < pageSize) break
        if (allTraders.length >= 2000) break
        await this.delay(300) // eToro rate limits
      } catch {
        break
      }
    }

    return {
      platform: this.platform,
      market_type: 'spot',
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

registerScraper('etoro', async () => new EtoroScraper())
