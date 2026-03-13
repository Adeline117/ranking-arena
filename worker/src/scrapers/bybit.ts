/**
 * Bybit Copy Trading 爬虫
 * 重构自 scripts/import_bybit.mjs
 * 使用 Playwright 代替 puppeteer-extra
 */

import { BaseScraper } from './base.js'
import type { TraderData, TimeRange } from '../types.js'

export class BybitScraper extends BaseScraper {
  private readonly baseUrl = 'https://www.bybit.com/zh-CN/copyTrade/'
  private readonly targetCount = 100
  private readonly maxScrolls = 100

  constructor() {
    super('bybit')
  }

  protected async scrapeData(timeRange: TimeRange): Promise<TraderData[]> {
    const traders: TraderData[] = []
    const seenIds = new Set<string>()

    this.log.info('Starting Bybit scrape', {
      timeRange,
      targetCount: this.targetCount,
    })

    // 访问页面
    try {
      await this.navigateWithRetry(this.baseUrl)
    } catch (error) {
      this.log.warn('Initial page load timeout, continuing', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await this.wait(8000)

    // 关闭地区弹窗
    this.log.info('Closing region popup')
    await this.page!.evaluate(() => {
      document.querySelectorAll('button, div').forEach(btn => {
        if ((btn as HTMLElement).textContent?.includes("don't live")) {
          (btn as HTMLElement).click()
        }
      })
    })
    await this.wait(2000)

    // 滚动到 Tab 栏位置
    this.log.info('Scrolling to tab bar')
    await this.page!.evaluate(() => window.scrollTo(0, 600))
    await this.wait(2000)

    // 点击 "All Traders" Tab
    this.log.info('Clicking All Traders tab')
    const clickedAllTraders = await this.page!.evaluate(() => {
      const allElements = document.querySelectorAll('*')
      for (const el of allElements) {
        if (el.children.length === 0 || el.children.length === 1) {
          const text = el.textContent?.trim()
          if (text === 'All Traders') {
            (el as HTMLElement).click()
            return true
          }
        }
      }
      return false
    })
    this.log.debug('All Traders tab clicked', { success: clickedAllTraders })
    await this.wait(3000)

    // 点击 "Top ROI" 按钮
    this.log.info('Clicking Top ROI sort')
    await this.page!.evaluate(() => {
      const elements = document.querySelectorAll('*')
      for (const el of elements) {
        const text = el.textContent?.trim()
        if (text === 'Top ROI') {
          (el as HTMLElement).click()
          return true
        }
      }
      return false
    })
    await this.wait(3000)

    // 滚动并收集数据
    this.log.info('Starting scroll collection')
    let noNewDataCount = 0

    for (let scroll = 1; scroll <= this.maxScrolls; scroll++) {
      // 滚动页面
      await this.page!.evaluate(() => window.scrollBy(0, 500))
      await this.wait(600)

      // 每5次滚动提取一次
      if (scroll % 5 === 0) {
        const pageTraders = await this.extractTraders()

        let newCount = 0
        for (const t of pageTraders) {
          if (!seenIds.has(t.traderId)) {
            seenIds.add(t.traderId)
            traders.push(t)
            newCount++
          }
        }

        this.log.debug('Scroll progress', {
          scroll,
          pageCount: pageTraders.length,
          newCount,
          totalCount: traders.length,
        })

        if (traders.length >= this.targetCount) {
          this.log.info('Target count reached', { count: traders.length })
          break
        }

        if (newCount === 0) {
          noNewDataCount++
          if (noNewDataCount >= 5) {
            this.log.info('No new data for 5 consecutive checks, stopping')
            break
          }
        } else {
          noNewDataCount = 0
        }
      }
    }

    // 保存截图
    await this.takeScreenshot(`bybit_${timeRange}`)

    // 排序并返回
    const result = traders
      .sort((a, b) => (b.roi || 0) - (a.roi || 0))
      .slice(0, this.targetCount)
      .map((t, idx) => ({ ...t, rank: idx + 1 }))

    // 数据质量检查
    const topRoi = result[0]?.roi || 0
    if (topRoi < 300) {
      this.log.warn('Data quality warning: Top ROI seems low', { topRoi })
    }

    return result
  }

  private async extractTraders(): Promise<TraderData[]> {
    const pageTraders = await this.page!.evaluate(() => {
      const traders: Array<{
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
      const seen = new Set<string>()

      const text = document.body.innerText
      const chunks = text.split('Copy')

      chunks.forEach(chunk => {
        const lines = chunk.split('\n').map(l => l.trim()).filter(l => l)

        let roi: number | null = null
        let nickname: string | null = null

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]

          // 找 +xxx.xx% 格式的 ROI
          if (line.match(/^\+[\d,.]+[‎]?%$/)) {
            roi = parseFloat(line.replace(/[^\d.]/g, ''))

            // 向前找用户名
            for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
              const prev = lines[j]
              if (
                prev &&
                prev.length >= 3 &&
                prev.length <= 30 &&
                !prev.match(/^[\d,.%+\/-]+$/) &&
                prev !== 'ROI' &&
                prev !== '100' &&
                !prev.match(/^\d+d$/i) &&
                !prev.includes('Drawdown') &&
                !prev.includes('Sharpe') &&
                !prev.includes('View All') &&
                !prev.includes('Traders') &&
                !prev.includes('Master') &&
                !prev.includes('Leaderboard') &&
                !prev.includes('Check')
              ) {
                nickname = prev
                break
              }
            }
            break
          }
        }

        if (nickname && roi && roi > 0 && !seen.has(nickname)) {
          seen.add(nickname)
          traders.push({
            traderId: nickname,
            nickname,
            avatar: null,
            roi,
            pnl: 0,
            winRate: null,
            maxDrawdown: null,
            followers: 0,
            aum: null,
            tradesCount: null,
            rank: traders.length + 1,
          })
        }
      })

      return traders
    })

    return pageTraders
  }
}
