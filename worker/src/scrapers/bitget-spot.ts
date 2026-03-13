/**
 * Bitget Spot Copy Trading 爬虫
 * 重构自 scripts/import_bitget_spot.mjs
 * 使用 Playwright 拦截 API 请求获取数据
 */

import { BaseScraper } from './base.js'
import type { TraderData, TimeRange } from '../types.js'

// 时间段配置（Bitget 使用天数）
const PERIOD_CONFIG: Record<TimeRange, { days: string; url: string }> = {
  '7D': { days: '7', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=7' },
  '30D': { days: '30', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=30' },
  '90D': { days: '90', url: 'https://www.bitget.com/zh-CN/copy-trading/leaderboard-ranking/spot-roi/1?dateType=90' },
}

const PER_PAGE = 20

export class BitgetSpotScraper extends BaseScraper {
  private readonly targetCount = 100

  constructor() {
    super('bitget_spot')
  }

  protected async scrapeData(timeRange: TimeRange): Promise<TraderData[]> {
    const tradersMap = new Map<string, TraderData>()
    const config = PERIOD_CONFIG[timeRange]

    this.log.info('Starting Bitget Spot scrape', {
      timeRange,
      targetCount: this.targetCount,
      url: config.url,
    })

    // 设置 API 请求拦截
    const apiResponses: TraderData[][] = []

    await this.page!.route('**/v1/trace/spot/public/traderRankingList**', async route => {
      const response = await route.fetch()
      const json = await response.json()

      if (json.data?.list && Array.isArray(json.data.list)) {
        const traders = json.data.list
          .map((item: Record<string, unknown>, idx: number) => this.parseTraderFromApi(item, idx + 1))
          .filter((t: TraderData | null): t is TraderData => t !== null)
        
        apiResponses.push(traders)
        this.log.debug('API response captured', { count: traders.length })
      }

      await route.fulfill({ response })
    })

    // 访问页面
    try {
      await this.navigateWithRetry(config.url)
    } catch (error) {
      this.log.warn('Initial page load timeout, continuing', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await this.wait(8000)

    // 关闭弹窗
    await this.page!.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept')) {
          try { (btn as HTMLElement).click() } catch (_e) { /* ignore */ }
        }
      })
    })
    await this.wait(2000)

    // 收集第一页数据
    for (const traders of apiResponses) {
      for (const t of traders) {
        tradersMap.set(t.traderId, t)
      }
    }
    this.log.info('First page collected', { count: tradersMap.size })

    // 分页获取更多数据
    const totalPages = Math.ceil(this.targetCount / PER_PAGE)
    
    for (let page = 2; page <= totalPages; page++) {
      if (tradersMap.size >= this.targetCount) {
        this.log.info('Target count reached', { count: tradersMap.size })
        break
      }

      // 滚动到分页区域
      await this.page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await this.wait(1000)

      // 点击下一页
      const clicked = await this.page!.evaluate(() => {
        const nextBtn = document.querySelector('.bit-pagination-next:not(.bit-pagination-disabled)')
        if (nextBtn) {
          (nextBtn as HTMLElement).click()
          return true
        }
        return false
      })

      if (!clicked) {
        this.log.info('No more pages available')
        break
      }

      await this.wait(3000)

      // 收集新数据
      for (const traders of apiResponses) {
        for (const t of traders) {
          tradersMap.set(t.traderId, t)
        }
      }

      this.log.debug('Page collected', { page, totalCount: tradersMap.size })
    }

    // 保存截图
    await this.takeScreenshot(`bitget_spot_${timeRange}`)

    // 排序并返回
    const result = Array.from(tradersMap.values())
      .sort((a, b) => (b.roi || 0) - (a.roi || 0))
      .slice(0, this.targetCount)
      .map((t, idx) => ({ ...t, rank: idx + 1 }))

    this.log.info('Scrape completed', { totalCount: result.length })

    return result
  }

  private parseTraderFromApi(item: Record<string, unknown>, rank: number): TraderData | null {
    const traderId = String(item.traderId || item.traderUid || '')
    if (!traderId) return null

    // Bitget API 返回的 ROI 是字符串形式的百分比值，如 "7583.61" 表示 7583.61%
    const roi = parseFloat(String(item.roi ?? 0))

    return {
      traderId,
      nickname: String(item.nickName || item.displayName || item.userName || '') || null,
      avatar: String(item.headPic || '') || null,
      roi,
      pnl: parseFloat(String(item.totalPnl ?? 0)),
      winRate: null, // Bitget Spot API 不返回 winRate
      maxDrawdown: null,
      followers: parseInt(String(item.followCount ?? 0)),
      aum: parseFloat(String(item.aum ?? 0)),
      tradesCount: null,
      rank: (item.rankingNo as number) || rank,
    }
  }
}
