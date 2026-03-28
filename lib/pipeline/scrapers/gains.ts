/**
 * Gains Network Scraper (on-chain)
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

export class GainsScraper implements PlatformScraper {
  readonly platform = 'gains'

  private readonly SUBGRAPH_URL =
    'https://api.thegraph.com/subgraphs/name/gainsnetwork/gtrade-stats-arbitrum'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const startTime = Date.now()

    try {
      const query = `{
        traders(
          first: 500
          orderBy: totalPnl
          orderDirection: desc
        ) {
          id
          totalPnl
          totalVolume
          tradesCount
          wins
          losses
        }
      }`

      const response = await fetch(this.SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })

      if (!response.ok) {
        throw new Error(`Gains Subgraph returned ${response.status}`)
      }

      const data = await response.json()
      const latency = Date.now() - startTime
      const traders = data?.data?.traders || []

      // Gains only has all_time data
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: traders.map((item: Record<string, unknown>) => ({
          trader_id: String(item.id || '').toLowerCase(),
          raw_data: {
            id: item.id,
            totalPnl: item.totalPnl, // wei format
            totalVolume: item.totalVolume,
            tradesCount: item.tradesCount,
            wins: item.wins,
            losses: item.losses,
            _decimals: 18,
          },
        })),
        total_available: traders.length,
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
