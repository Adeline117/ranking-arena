/**
 * Binance Futures Scraper
 *
 * 职责：纯采集，只负责 HTTP 调用和返回原始 API 响应
 * 不做任何数据转换或计算
 *
 * 数据来源:
 * - Copy Trading API: /v1/friendly/future/copy-trade/home-page/query-list
 * - Trader Detail: /v1/friendly/future/copy-trade/lead-portfolio/detail
 *
 * 注意事项:
 * - API 有地理限制，需要通过 VPS 代理
 * - 速率限制约 20 req/min
 */

import { RawFetchResult, RawTraderEntry, TimeWindow } from '../types'
import { PlatformScraper, registerScraper } from '../runner'

// =============================================================================
// Types
// =============================================================================

interface BinanceQueryListResponse {
  code: string // "000000" = success
  data: {
    total: number
    list: BinanceLeaderEntry[]
  } | null
  message?: string
}

interface BinanceLeaderEntry {
  leadPortfolioId: string
  encryptedUid?: string
  nickname: string | null
  userPhotoUrl?: string | null
  roi: number // percentage (25.5 = 25.5%)
  pnl: number // USD
  winRate?: number // percentage
  mdd?: number // percentage (max drawdown)
  followerCount?: number
  currentCopyCount?: number
  aum?: number
  tradeCount?: number
  sharpeRatio?: number
  avgHoldingTime?: number // hours
  rank?: number
}

// =============================================================================
// Scraper Implementation
// =============================================================================

export class BinanceFuturesScraper implements PlatformScraper {
  readonly platform = 'binance_futures'

  private readonly BASE_URL = 'https://www.binance.com/bapi/futures'
  private readonly VPS_PROXY_URL = process.env.VPS_PROXY_URL

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
        console.error(`[BinanceFuturesScraper] Error fetching ${window}:`, error)
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
    const periodType = this.mapWindow(window)
    const pageSize = 20
    const maxPages = 100 // 最多获取 2000 个 trader
    const allTraders: RawTraderEntry[] = []

    for (let page = 1; page <= maxPages; page++) {
      const requestBody = {
        pageNumber: page,
        pageSize,
        timeRange: periodType,
        dataType: 'ROI',
        favoriteOnly: false,
        hideFull: false,
        nickname: '',
        order: 'DESC',
        userAsset: 0,
        portfolioType: 'ALL',
        useAiRecommended: false,
      }

      const response = await this.makeRequest<BinanceQueryListResponse>(
        `${this.BASE_URL}/v1/friendly/future/copy-trade/home-page/query-list`,
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://www.binance.com',
            Referer: 'https://www.binance.com/en/copy-trading',
          },
        }
      )

      if (!response || response.code !== '000000' || !response.data?.list) {
        break
      }

      const list = response.data.list
      if (list.length === 0) break

      // 保存原始数据，不做任何转换
      for (const entry of list) {
        allTraders.push({
          trader_id: entry.leadPortfolioId || entry.encryptedUid || '',
          raw_data: entry as unknown as Record<string, unknown>,
        })
      }

      if (list.length < pageSize) break
      if (allTraders.length >= 2000) break

      // 速率限制
      await this.delay(500)
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
   * 发送 HTTP 请求（优先使用 VPS 代理）
   */
  private async makeRequest<T>(
    url: string,
    options: RequestInit
  ): Promise<T | null> {
    // 优先使用 VPS 代理（Binance 有地理限制）
    if (this.VPS_PROXY_URL) {
      try {
        const proxyResponse = await fetch(`${this.VPS_PROXY_URL}/proxy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            method: options.method || 'GET',
            headers: options.headers,
            body: options.body ? JSON.parse(options.body as string) : undefined,
          }),
        })

        if (proxyResponse.ok) {
          return (await proxyResponse.json()) as T
        }
      } catch (error) {
        console.warn('[BinanceFuturesScraper] VPS proxy failed:', error)
      }
    }

    // 直接请求（可能被地理限制）
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      })

      if (!response.ok) {
        console.warn(`[BinanceFuturesScraper] HTTP ${response.status}: ${url}`)
        return null
      }

      return (await response.json()) as T
    } catch (error) {
      console.error('[BinanceFuturesScraper] Direct request failed:', error)
      return null
    }
  }

  /**
   * 时间窗口映射
   */
  private mapWindow(window: TimeWindow): string {
    const mapping: Record<TimeWindow, string> = {
      '7d': '7D',
      '30d': '30D',
      '90d': '90D',
    }
    return mapping[window]
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// =============================================================================
// Register Scraper
// =============================================================================

registerScraper('binance_futures', async () => new BinanceFuturesScraper())

// Export for direct use
export function getBinanceFuturesScraper(): PlatformScraper {
  return new BinanceFuturesScraper()
}
