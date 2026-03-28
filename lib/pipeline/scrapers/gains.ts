/**
 * Gains Network Scraper (Arbitrum/Polygon/Base)
 *
 * Uses Gains Network's REST API leaderboard endpoint.
 * API: GET https://backend-{chain}.gains.trade/leaderboard
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const CHAINS = ['arbitrum', 'polygon', 'base']

export class GainsScraper implements PlatformScraper {
  readonly platform = 'gains'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const startTime = Date.now()

    try {
      const seen = new Set<string>()
      const allTraders: RawTraderEntry[] = []

      // Fetch from all chains in parallel
      const chainResults = await Promise.allSettled(
        CHAINS.map(async (chain) => {
          const url = `https://backend-${chain}.gains.trade/leaderboard`
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
          })

          if (!response.ok) {
            throw new Error(`Gains ${chain} API returned ${response.status}`)
          }

          const data = await response.json()
          return { chain, data }
        })
      )

      for (const result of chainResults) {
        if (result.status === 'rejected') continue

        const { chain, data } = result.value
        if (!Array.isArray(data)) continue

        for (const entry of data) {
          const address = String(entry.address || entry.trader || '').toLowerCase()
          if (!address || seen.has(address)) continue
          seen.add(address)

          allTraders.push({
            trader_id: address,
            raw_data: {
              address,
              pnl: entry.total_pnl_usd ?? entry.total_pnl ?? entry.pnl,
              roi: entry.roi ?? entry.pnlPercent ?? entry.returnRate,
              count_win: entry.count_win,
              count_loss: entry.count_loss,
              count: entry.count ?? entry.totalTrades,
              avg_win: entry.avg_win,
              avg_loss: entry.avg_loss,
              avgPositionSize: entry.avgPositionSize,
              totalVolume: entry.totalVolume ?? entry.total_volume ?? entry.volume,
              _chain: chain,
            },
          })

          if (allTraders.length >= 2000) break
        }

        if (allTraders.length >= 2000) break
      }

      const latency = Date.now() - startTime

      // Gains provides all_time data, return same for all windows
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: allTraders,
        total_available: allTraders.length,
        fetched_at: new Date(),
        api_latency_ms: latency,
      }))
    } catch (error) {
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: [],
        total_available: 0,
        fetched_at: new Date(),
        api_latency_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
}

registerScraper('gains', async () => new GainsScraper())
