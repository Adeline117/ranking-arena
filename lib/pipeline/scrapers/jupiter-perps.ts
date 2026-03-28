/**
 * Jupiter Perps Scraper (Solana)
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class JupiterPerpsScraper implements PlatformScraper {
  readonly platform = 'jupiter_perps'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const startTime = Date.now()

    try {
      // Jupiter has a single leaderboard endpoint
      const response = await fetch(
        'https://perps-api.jup.ag/v1/leaderboard?limit=500',
        { method: 'GET' }
      )

      if (!response.ok) {
        throw new Error(`Jupiter API returned ${response.status}`)
      }

      const data = await response.json()
      const latency = Date.now() - startTime
      const leaderboard = data?.leaderboard || data || []

      // Return same data for all windows (Jupiter doesn't have window filtering)
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: leaderboard.map((item: Record<string, unknown>) => ({
          trader_id: String(item.wallet || item.authority || ''),
          raw_data: {
            wallet: item.wallet,
            authority: item.authority,
            pnl: item.pnl,
            volume: item.volume,
            trades: item.trades,
            rank: item.rank,
          },
        })),
        total_available: leaderboard.length,
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

registerScraper('jupiter_perps', async () => new JupiterPerpsScraper())
