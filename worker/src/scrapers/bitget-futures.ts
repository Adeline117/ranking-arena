/**
 * Bitget Futures Copy Trading 爬虫
 * 重构自 scripts/import_bitget_futures.mjs
 * 使用 Playwright 代替 puppeteer-extra
 */

import { BaseScraper } from './base.js'
import type { TraderData, TimeRange } from '../types.js'

// URL 参数: rule=2 (ROI排序)
// sort=1 7天, sort=2 30天, sort=0 90天
const PERIOD_CONFIG: Record<TimeRange, string> = {
  '7D': 'https://www.bitget.com/asia/copy-trading/futures/all?rule=2&sort=1',
  '30D': 'https://www.bitget.com/asia/copy-trading/futures/all?rule=2&sort=2',
  '90D': 'https://www.bitget.com/asia/copy-trading/futures/all?rule=2&sort=0',
}

export class BitgetFuturesScraper extends BaseScraper {
  private readonly targetCount = 100
  private readonly maxPages = 10

  constructor() {
    super('bitget')
  }

  protected async scrapeData(timeRange: TimeRange): Promise<TraderData[]> {
    const allTraders = new Map<string, TraderData>()
    const url = PERIOD_CONFIG[timeRange]

    this.log.info('Starting Bitget Futures scrape', {
      timeRange,
      targetCount: this.targetCount,
      url,
    })

    // 访问页面
    try {
      await this.navigateWithRetry(url)
    } catch (error) {
      this.log.warn('Initial page load timeout, continuing', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await this.wait(10000)

    // 关闭弹窗
    this.log.info('Closing popups')
    await this.page!.evaluate(() => {
      document.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent || ''
        if (text.includes('OK') || text.includes('Got') || text.includes('Accept') || text.includes('Confirm')) {
          try { (btn as HTMLElement).click() } catch (_e) { /* ignore */ }
        }
      })
    })
    await this.wait(2000)

    // 第 1 页
    let traders = await this.extractTraders()
    traders.forEach(t => allTraders.set(t.traderId, t))
    this.log.info('First page extracted', { count: allTraders.size })

    // 分页获取
    this.log.info('Starting pagination')
    
    for (let pageNum = 2; pageNum <= this.maxPages; pageNum++) {
      if (allTraders.size >= this.targetCount) {
        this.log.info('Target count reached', { count: allTraders.size })
        break
      }

      // 滚动到分页位置
      await this.page!.evaluate(() => window.scrollTo(0, 3500))
      await this.wait(1000)

      // 点击页码
      const clicked = await this.page!.evaluate((pageNum: number) => {
        const items = document.querySelectorAll('.bit-pagination-item a, .bit-pagination-item')
        for (const item of items) {
          if (item.textContent?.trim() === String(pageNum)) {
            (item as HTMLElement).click()
            return true
          }
        }
        return false
      }, pageNum)

      if (!clicked) {
        this.log.info('Could not navigate to page', { pageNum })
        break
      }

      await this.wait(5000)

      // 滚动回顶部
      await this.page!.evaluate(() => window.scrollTo(0, 0))
      await this.wait(1000)

      traders = await this.extractTraders()
      const before = allTraders.size
      traders.forEach(t => allTraders.set(t.traderId, t))
      
      this.log.debug('Page extracted', { 
        pageNum, 
        newCount: allTraders.size - before,
        totalCount: allTraders.size,
      })
    }

    // 保存截图
    await this.takeScreenshot(`bitget_futures_${timeRange}`)

    // 排序并返回
    const result = Array.from(allTraders.values())
      .sort((a, b) => (b.roi || 0) - (a.roi || 0))
      .slice(0, this.targetCount)
      .map((t, idx) => ({ ...t, rank: idx + 1 }))

    this.log.info('Scrape completed', { totalCount: result.length })

    return result
  }

  private async extractTraders(): Promise<TraderData[]> {
    const pageTraders = await this.page!.evaluate(() => {
      const results: Array<{
        traderId: string
        nickname: string | null
        avatar: string | null
        roi: number
        pnl: number
        winRate: number | null
        maxDrawdown: number | null
        followers: number
        aum: number | null
        tradesCount: number | null
        rank: number
      }> = []

      // 按 "Copy" 按钮分割内容
      document.body.innerText.split(/Copy(?!right)/).forEach((chunk, idx) => {
        if (idx === 0) return

        // 匹配 ROI
        const roiMatch = chunk.match(/([+-]?[\d,]+\.\d+)%/)
        if (roiMatch) {
          const roi = parseFloat(roiMatch[1].replace(/,/g, ''))
          
          // 提取用户名（在 ROI 前面的有效文本）
          const lines = chunk.split('\n')
            .map(l => l.trim())
            .filter(l => l && l.length > 2 && l.length < 30)
          
          if (lines[0] && roi > 0) {
            const nickname = lines[0]
            results.push({
              traderId: nickname, // 使用昵称作为 ID
              nickname,
              avatar: null,
              roi,
              pnl: 0,
              winRate: null,
              maxDrawdown: null,
              followers: 0,
              aum: null,
              tradesCount: null,
              rank: results.length + 1,
            })
          }
        }
      })

      return results
    })

    return pageTraders
  }
}
