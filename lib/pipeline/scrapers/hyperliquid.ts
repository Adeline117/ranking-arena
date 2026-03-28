/**
 * Hyperliquid Scraper
 *
 * 职责：纯采集，只负责 HTTP 调用和返回原始 API 响应
 * 不做任何数据转换或计算（ROI 格式检测由 Normalizer 处理）
 *
 * 数据来源:
 * - Primary: https://stats-data.hyperliquid.xyz/Mainnet/leaderboard (GET)
 * - Fallback: https://api.hyperliquid.xyz/info (POST, type: leaderboard)
 *
 * 注意事项:
 * - DEX 平台，无地理限制
 * - ROI 可能是小数或百分比格式（由 Normalizer 处理）
 * - 没有 followers/copiers/aum（DEX 特性）
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

// =============================================================================
// Types
// =============================================================================

interface HyperliquidLeaderboardEntry {
  ethAddress?: string
  user?: string
  displayName?: string | null
  accountValue?: number
  windowPerformances?:
    | [string, { roi?: number; pnl?: number; vlm?: number }][] // Array format
    | Record<string, { roi?: number; pnl?: number; vlm?: number }> // Object format
}

// =============================================================================
// Scraper Implementation
// =============================================================================

export class HyperliquidScraper implements PlatformScraper {
  readonly platform = 'hyperliquid'

  /**
   * 获取所有时间窗口的排行榜数据
   */
  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    // Hyperliquid 的 stats-data endpoint 返回所有窗口的数据
    // 只需要调用一次，然后按窗口分割
    const startTime = Date.now()

    try {
      const rawData = await this.fetchLeaderboard()
      const latency = Date.now() - startTime

      // 为每个请求的窗口创建结果
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: this.extractTradersForWindow(rawData, window),
        total_available: rawData.length,
        fetched_at: new Date(),
        api_latency_ms: latency,
      }))
    } catch (error) {
      // 返回错误结果
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

  /**
   * 从 stats-data endpoint 获取排行榜
   */
  private async fetchLeaderboard(): Promise<HyperliquidLeaderboardEntry[]> {
    // Primary: stats-data endpoint (GET, always works)
    try {
      const response = await fetch(
        'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
        {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        }
      )

      if (response.ok) {
        const data = await response.json()
        // 可能返回 { leaderboardRows: [...] } 或直接 [...]
        return data.leaderboardRows || data || []
      }
    } catch (error) {
      console.warn('[HyperliquidScraper] stats-data endpoint failed:', error)
    }

    // Fallback: info POST endpoint
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'leaderboard', timeWindow: 'allTime' }),
      })

      if (response.ok) {
        const data = await response.json()
        return data.leaderboardRows || data || []
      }
    } catch (error) {
      console.warn('[HyperliquidScraper] info POST endpoint failed:', error)
    }

    throw new Error('All Hyperliquid endpoints failed')
  }

  /**
   * 为特定窗口提取交易员数据
   * 保留原始数据，不做转换
   */
  private extractTradersForWindow(
    data: HyperliquidLeaderboardEntry[],
    window: TimeWindow
  ): RawTraderEntry[] {
    // 映射窗口到 Hyperliquid 的 key
    const windowKey = this.mapWindowKey(window)

    return data.slice(0, 500).map((entry) => {
      const traderId = entry.ethAddress || entry.user || ''

      // 提取该窗口的性能数据（保留原始格式）
      let windowPerf: Record<string, unknown> | null = null
      const wp = entry.windowPerformances

      if (Array.isArray(wp)) {
        // Array format: [["day", {...}], ["week", {...}], ...]
        const found = wp.find((pair) => pair[0] === windowKey)
        if (found) {
          windowPerf = found[1] as Record<string, unknown>
        }
      } else if (wp && typeof wp === 'object') {
        // Object format: { day: {...}, week: {...}, ... }
        windowPerf = (wp as Record<string, Record<string, unknown>>)[windowKey] || null
      }

      return {
        trader_id: traderId,
        raw_data: {
          // 保留所有原始字段
          ethAddress: entry.ethAddress,
          user: entry.user,
          displayName: entry.displayName,
          accountValue: entry.accountValue,
          // 展平该窗口的性能数据
          roi: windowPerf?.roi,
          pnl: windowPerf?.pnl,
          vlm: windowPerf?.vlm,
          // 保留原始 windowPerformances 供调试
          _windowPerformances: entry.windowPerformances,
          _extractedWindow: windowKey,
        },
      }
    })
  }

  /**
   * 映射 TimeWindow 到 Hyperliquid 的 key
   */
  private mapWindowKey(window: TimeWindow): string {
    const mapping: Record<TimeWindow, string> = {
      '7d': 'week',
      '30d': 'month',
      '90d': 'allTime', // Hyperliquid 没有原生 90d，用 allTime
    }
    return mapping[window]
  }
}

// =============================================================================
// Register Scraper
// =============================================================================

registerScraper('hyperliquid', async () => new HyperliquidScraper())

// Export for direct use
export function getHyperliquidScraper(): PlatformScraper {
  return new HyperliquidScraper()
}
