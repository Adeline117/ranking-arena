/**
 * eToro Scraper
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, string> = { '7d': 'OneWeek', '30d': 'OneMonth', '90d': 'ThreeMonths' }

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
      const url = `https://www.etoro.com/sapi/rankings/cid/2/rankings/?Period=${period}&SortBy=Profit&PageNumber=${page}&ItemsPerPage=${pageSize}`

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
          allTraders.push({
            trader_id: item.UserName || item.CustomerId || '',
            raw_data: {
              userName: item.UserName,
              customerId: item.CustomerId,
              gain: item.Gain,          // ROI percentage
              profit: item.Profit,
              copiers: item.Copiers,
              copiersChange: item.CopiersChange,
              riskScore: item.RiskScore,
              maxDailyRiskScore: item.MaxDailyRiskScore,
              maxMonthlyRiskScore: item.MaxMonthlyRiskScore,
              trades: item.Trades,
              profitableWeeks: item.ProfitableWeeks,
              profitableMonths: item.ProfitableMonths,
              avgProfitPct: item.AvgProfitPct,
              avgLossPct: item.AvgLossPct,
              winRatio: item.WinRatio,
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
