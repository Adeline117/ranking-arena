/**
 * BloFin Futures Scraper
 *
 * BloFin copy trading API requires authentication (returns 401/403).
 * This scraper is a placeholder until we implement authenticated access.
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

const WINDOW_MAP: Record<TimeWindow, string> = { '7d': '7', '30d': '30', '90d': '90' }

export class BlofinFuturesScraper implements PlatformScraper {
  readonly platform = 'blofin'

  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    // BloFin API requires authentication - returns 401/403 for public endpoints
    return windows.map((window) => ({
      platform: this.platform,
      market_type: 'futures' as const,
      window,
      raw_traders: [],
      total_available: 0,
      fetched_at: new Date(),
      api_latency_ms: 0,
      error: 'BloFin copy trading API requires authentication - no public endpoint available',
    }))
  }

  private async fetchWindow(window: TimeWindow): Promise<RawFetchResult> {
    const startTime = Date.now()
    const period = WINDOW_MAP[window]
    const allTraders: RawTraderEntry[] = []

    // Try multiple API endpoints
    const endpoints = [
      `https://openapi.blofin.com/api/v1/copy-trading/public/current-lead-traders?limit=100&period=${period}`,
      `https://www.blofin.com/api/v1/copytrading/public/leaderboard?sortBy=roi&period=${period}&limit=100`,
    ]

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Origin': 'https://blofin.com',
            'Referer': 'https://blofin.com/en/copy-trade',
          },
        })

        if (!response.ok) continue

        const data = await response.json()
        const list = data?.data?.list || data?.data?.items || data?.data || []

        if (Array.isArray(list) && list.length > 0) {
          for (const item of list) {
            allTraders.push({
              trader_id: String(item.traderId || item.uniqueName || item.uid || ''),
              raw_data: {
                traderId: item.traderId,
                uniqueName: item.uniqueName,
                nickName: item.nickName || item.nickname,
                avatar: item.avatar || item.avatarUrl,
                roi: item.roi || item.returnRate || item.pnlRatio,
                pnl: item.pnl || item.profit || item.totalPnl,
                followers: item.followers || item.followerCount,
                winRate: item.winRate,
                sharpeRatio: item.sharpeRatio,
                maxDrawdown: item.maxDrawdown || item.mdd,
              },
            })
          }
          break // Got data, stop trying other endpoints
        }
      } catch (err) {
        console.warn('[scraper-blofin] endpoint fetch fallback:', err instanceof Error ? err.message : String(err))
        continue
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

registerScraper('blofin', async () => new BlofinFuturesScraper())
registerScraper('blofin_futures', async () => new BlofinFuturesScraper())
