/**
 * GMX Scraper
 *
 * 职责：纯采集，只负责 GraphQL 调用和返回原始响应
 * 不做任何数据转换（wei→USD 转换由 Normalizer 处理）
 *
 * 数据来源:
 * - Subsquid GraphQL: https://gmx.squids.live/gmx-synthetics-arbitrum/graphql
 *
 * 注意事项:
 * - 链上数据，无地理限制
 * - PnL 是 wei 格式（需要除以 10^30）
 * - ROI 需要计算（realizedPnl / maxCapital）
 * - 只有 all_time 数据，无原生 7d/30d/90d
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

// =============================================================================
// Scraper Implementation
// =============================================================================

export class GmxScraper implements PlatformScraper {
  readonly platform = 'gmx'

  private readonly SUBGRAPH_URL =
    'https://gmx.squids.live/gmx-synthetics-arbitrum/graphql'

  /**
   * 获取所有时间窗口的排行榜数据
   * GMX 只有 all_time 数据，对所有窗口返回相同数据
   */
  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const startTime = Date.now()

    try {
      const rawData = await this.fetchLeaderboard()
      const latency = Date.now() - startTime

      // GMX 没有原生时间窗口，所有窗口返回相同的 all_time 数据
      return windows.map((window) => ({
        platform: this.platform,
        market_type: 'perp' as const,
        window,
        raw_traders: rawData,
        total_available: rawData.length,
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

  /**
   * 从 Subsquid GraphQL 获取排行榜
   */
  private async fetchLeaderboard(): Promise<RawTraderEntry[]> {
    const query = `{
      accountStats(
        limit: 2000
        orderBy: realizedPnl_DESC
      ) {
        id
        realizedPnl
        volume
        netCapital
        maxCapital
        wins
        losses
        closedCount
      }
    }`

    const response = await fetch(this.SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    if (!response.ok) {
      throw new Error(`GMX Subgraph returned ${response.status}`)
    }

    const data = await response.json()
    const accountStats = data?.data?.accountStats || []

    if (!Array.isArray(accountStats)) {
      throw new Error('GMX Subgraph returned invalid data format')
    }

    // 返回原始数据，不做任何转换
    return accountStats.map((item: Record<string, unknown>) => {
      const address = String(item.id || item.account || '').toLowerCase()

      return {
        trader_id: address,
        raw_data: {
          // 原始 GraphQL 响应字段
          id: item.id,
          realizedPnl: item.realizedPnl, // wei 格式，由 Normalizer 转换
          volume: item.volume,
          netCapital: item.netCapital,
          maxCapital: item.maxCapital, // 用于计算 ROI
          wins: item.wins,
          losses: item.losses,
          closedCount: item.closedCount,
          // 标记数据来源
          _source: 'subsquid',
          _decimals: 30, // GMX v2 uses 30 decimals
        },
      }
    })
  }
}

// =============================================================================
// Register Scraper
// =============================================================================

registerScraper('gmx', async () => new GmxScraper())

export function getGmxScraper(): PlatformScraper {
  return new GmxScraper()
}
