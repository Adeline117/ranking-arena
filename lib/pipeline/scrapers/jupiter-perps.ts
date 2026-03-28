/**
 * Jupiter Perps Scraper (Solana)
 *
 * Uses week-based top-traders API with multi-market aggregation.
 * API: GET https://perps-api.jup.ag/v1/top-traders
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

// Jupiter market mints
const MARKETS = [
  'So11111111111111111111111111111111111111112',   // SOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // BTC
]

const WEEKS_MAP: Record<TimeWindow, number> = { '7d': 1, '30d': 4, '90d': 6 }

interface JupiterTraderEntry {
  owner: string
  totalPnlUsd: number | string
  totalVolumeUsd?: number | string
  totalVolume?: number
  totalTrades?: number
}

export class JupiterPerpsScraper implements PlatformScraper {
  readonly platform = 'jupiter_perps'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const results: RawFetchResult[] = []

    for (const window of windows) {
      try {
        const result = await this.fetchWindow(window)
        results.push(result)
      } catch (error) {
        results.push({
          platform: this.platform,
          market_type: 'perp',
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
    const numWeeks = WEEKS_MAP[window]
    const now = new Date()
    const traderMap = new Map<string, {
      pnl: number
      volume: number
      trades: number
      wins: number
      losses: number
    }>()

    // Generate week list
    const weeks: Array<{ year: number; week: number }> = []
    for (let i = 0; i < numWeeks; i++) {
      const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000)
      weeks.push(this.getISOWeek(d))
    }

    // Fetch all markets × weeks
    for (const { year, week } of weeks) {
      const marketResults = await Promise.allSettled(
        MARKETS.map(async (mint) => {
          const url = `https://perps-api.jup.ag/v1/top-traders?marketMint=${mint}&year=${year}&week=${week}`
          const response = await fetch(url)
          if (!response.ok) throw new Error(`Jupiter API returned ${response.status}`)
          return response.json()
        })
      )

      for (const result of marketResults) {
        if (result.status === 'rejected') continue
        const rawData = result.value as Record<string, unknown> | JupiterTraderEntry[]

        // API returns { topTradersByPnl: [...] } or direct array
        const data: JupiterTraderEntry[] = Array.isArray(rawData)
          ? rawData
          : Array.isArray((rawData as Record<string, unknown>)?.topTradersByPnl)
            ? (rawData as Record<string, unknown>).topTradersByPnl as JupiterTraderEntry[]
            : []

        for (const entry of data) {
          if (!entry.owner) continue
          const existing = traderMap.get(entry.owner) || {
            pnl: 0,
            volume: 0,
            trades: 0,
            wins: 0,
            losses: 0,
          }

          const weekPnl = Number(entry.totalPnlUsd || 0) / 1e6
          existing.pnl += weekPnl
          existing.volume += Number(entry.totalVolumeUsd || entry.totalVolume || 0) / 1e6
          existing.trades += entry.totalTrades || 0
          if (weekPnl > 0) existing.wins++
          else if (weekPnl < 0) existing.losses++

          traderMap.set(entry.owner, existing)
        }
      }
      // Brief delay between weeks
      await this.delay(200)
    }

    // Convert to raw traders, sorted by PnL
    const sorted = Array.from(traderMap.entries())
      .sort(([, a], [, b]) => b.pnl - a.pnl)
      .slice(0, 500)

    const raw_traders: RawTraderEntry[] = sorted.map(([owner, data]) => ({
      trader_id: owner,
      raw_data: {
        owner,
        pnl: data.pnl,
        volume: data.volume,
        trades: data.trades,
        wins: data.wins,
        losses: data.losses,
        _computed_win_rate: (data.wins + data.losses) > 0
          ? (data.wins / (data.wins + data.losses)) * 100
          : null,
      },
    }))

    return {
      platform: this.platform,
      market_type: 'perp',
      window,
      raw_traders,
      total_available: traderMap.size,
      fetched_at: new Date(),
      api_latency_ms: Date.now() - startTime,
    }
  }

  private getISOWeek(date: Date): { year: number; week: number } {
    const d = new Date(date.getTime())
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
    return { year: d.getUTCFullYear(), week: weekNo }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

registerScraper('jupiter_perps', async () => new JupiterPerpsScraper())
