/**
 * Kwenta Perpetual Scraper (Optimism)
 *
 * Uses Kwenta's subgraph on The Graph for trader stats.
 * Requires THEGRAPH_API_KEY and KWENTA_SUBGRAPH_ID env vars.
 * Note: Old hosted service (api.thegraph.com) is deprecated.
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

function getSubgraphUrl(): string {
  const apiKey = process.env.THEGRAPH_API_KEY
  const subgraphId = process.env.KWENTA_SUBGRAPH_ID
  if (apiKey && subgraphId) {
    return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`
  }
  // Fallback to old hosted service (deprecated)
  return 'https://api.thegraph.com/subgraphs/name/kwenta/optimism-perps'
}

export class KwentaScraper implements PlatformScraper {
  readonly platform = 'kwenta'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const startTime = Date.now()

    // Check if env vars are set
    if (!process.env.THEGRAPH_API_KEY || !process.env.KWENTA_SUBGRAPH_ID) {
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: [],
        total_available: 0,
        fetched_at: new Date(),
        api_latency_ms: 0,
        error: 'Kwenta requires THEGRAPH_API_KEY and KWENTA_SUBGRAPH_ID env vars',
      }))
    }

    try {
      const query = `
        query GetTopTraders($limit: Int!) {
          futuresStats(
            first: $limit
            orderBy: pnl
            orderDirection: desc
            where: { totalTrades_gt: 5 }
          ) {
            id
            account
            pnl
            pnlWithFeesPaid
            totalVolume
            feesPaid
            liquidations
            totalTrades
            smartMarginVolume
          }
        }
      `

      const response = await fetch(getSubgraphUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { limit: 500 },
        }),
      })

      if (!response.ok) {
        throw new Error(`Kwenta subgraph returned ${response.status}`)
      }

      const data = await response.json()
      const latency = Date.now() - startTime
      const stats = data?.data?.futuresStats || []

      const raw_traders: RawTraderEntry[] = stats.map((item: Record<string, unknown>) => ({
        trader_id: String(item.account || item.id || '').toLowerCase(),
        raw_data: {
          account: item.account,
          pnl: item.pnl,                     // wei (18 decimals)
          pnlWithFeesPaid: item.pnlWithFeesPaid,
          totalVolume: item.totalVolume,     // wei
          feesPaid: item.feesPaid,
          liquidations: item.liquidations,
          totalTrades: item.totalTrades,
          smartMarginVolume: item.smartMarginVolume,
          _decimals: 18,
        },
      }))

      // Kwenta only has all_time data from subgraph
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders,
        total_available: raw_traders.length,
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

registerScraper('kwenta', async () => new KwentaScraper())
