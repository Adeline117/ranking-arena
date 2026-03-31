/**
 * OKX Futures Scraper
 *
 * 职责：纯采集，只负责 HTTP 调用和返回原始 API 响应
 *
 * 数据来源:
 * - v5 API: /api/v5/copytrading/public-lead-traders
 *
 * 注意事项:
 * - CloudFlare 保护，可能需要代理
 * - 每页最多 20 条
 * - ROI/Win Rate 返回小数格式（0.25 = 25%）
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('scraper:okx-futures')

// =============================================================================
// Scraper Implementation
// =============================================================================

export class OkxFuturesScraper implements PlatformScraper {
  readonly platform = 'okx_futures'

  /**
   * 获取所有时间窗口的排行榜数据
   */
  async fetch(windows: TimeWindow[]): Promise<RawFetchResult[]> {
    const results: RawFetchResult[] = []

    for (const window of windows) {
      try {
        const result = await this.fetchWindow(window)
        results.push(result)
      } catch (error) {
        log.error(`Error fetching ${window}`, { error: error instanceof Error ? error.message : String(error) })
        results.push({
          platform: this.platform,
          market_type: 'futures',
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

  /**
   * 获取单个时间窗口的排行榜
   */
  private async fetchWindow(window: TimeWindow): Promise<RawFetchResult> {
    const startTime = Date.now()
    const dataRange = this.mapWindow(window)
    const pageSize = 20
    const maxPages = 100 // 最多 2000 个 trader
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const url = `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&sortType=pnl&dataRange=${dataRange}&pageNo=${page}&limit=${pageSize}`

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        })

        if (!response.ok) {
          log.warn(`HTTP ${response.status} on page ${page}`)
          break
        }

        const data = await response.json()

        // v5 response: { code: "0", data: [{ ranks: [...], totalPage }] }
        if (data.code !== '0') {
          log.warn(`API error: ${data.msg}`)
          break
        }

        const dataArr = Array.isArray(data.data) ? data.data[0] : data.data
        const list = dataArr?.ranks || []

        if (!Array.isArray(list) || list.length === 0) break

        // 保存原始数据
        for (const item of list) {
          allTraders.push({
            trader_id: item.uniqueCode || item.uniqueName || '',
            raw_data: item,
          })
        }

        if (list.length < pageSize) break
        if (allTraders.length >= 2000) break

        // 速率限制
        await this.delay(100)
      } catch (error) {
        log.warn(`Page ${page} failed`, { error: error instanceof Error ? error.message : String(error) })
        break
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

  /**
   * 时间窗口映射
   */
  private mapWindow(window: TimeWindow): string {
    const mapping: Record<TimeWindow, string> = {
      '7d': '7d',
      '30d': '30d',
      '90d': '90d',
    }
    return mapping[window]
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// =============================================================================
// Register Scraper
// =============================================================================

registerScraper('okx_futures', async () => new OkxFuturesScraper())

export function getOkxFuturesScraper(): PlatformScraper {
  return new OkxFuturesScraper()
}
