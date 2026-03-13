/**
 * KuCoin Copy Trading 爬虫
 * 使用 Playwright 浏览器自动化绕过 Cloudflare
 */

import { Response } from 'playwright'
import { BaseScraper } from './base.js'
import type { TraderData, TimeRange } from '../types.js'

const PERIOD_CONFIG: Record<TimeRange, { tabTexts: string[]; minDays: number }> = {
  '7D': { tabTexts: ['7天', '7 Days', '7D'], minDays: 7 },
  '30D': { tabTexts: ['30天', '30 Days', '30D'], minDays: 30 },
  '90D': { tabTexts: ['90天', '90 Days', '90D'], minDays: 90 },
}

export class KucoinScraper extends BaseScraper {
  private readonly baseUrl = 'https://www.kucoin.com/copy-trading'
  private readonly targetCount = 200
  private apiResponses: Array<{ url: string; list: Record<string, unknown>[]; timestamp: number }> = []

  constructor() {
    super('kucoin')
  }

  protected async scrapeData(timeRange: TimeRange): Promise<TraderData[]> {
    const config = PERIOD_CONFIG[timeRange]
    const traders = new Map<string, TraderData>()

    this.log.info('Starting KuCoin scrape', {
      timeRange,
      targetCount: this.targetCount,
    })

    // 设置 API 响应拦截器
    this.page!.on('response', (response: Response) => this.handleApiResponse(response))

    // 访问页面
    try {
      await this.navigateWithRetry(this.baseUrl)
    } catch (error) {
      this.log.warn('Initial page load timeout, continuing', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await this.wait(5000)

    // 切换时间周期
    this.log.info('Switching time period', { timeRange })
    await this.switchTimePeriod(config.tabTexts)

    // 滚动加载更多数据
    for (let scroll = 0; scroll < 15; scroll++) {
      await this.page!.evaluate(() => window.scrollBy(0, 600))
      await this.wait(2000)

      // 处理 API 响应
      const recentResponses = this.apiResponses.filter(r => r.timestamp > Date.now() - 15000)
      for (const { list } of recentResponses) {
        list.forEach((item, idx) => {
          const trader = this.parseTrader(item, traders.size + idx + 1, config.minDays)
          if (trader && trader.traderId && !traders.has(trader.traderId)) {
            traders.set(trader.traderId, trader)
          }
        })
      }

      this.log.debug('Current traders count', { count: traders.size })

      if (traders.size >= this.targetCount) {
        this.log.info('Target count reached', { count: traders.size })
        break
      }
    }

    // 如果 API 拦截数据不够，尝试从 DOM 提取
    if (traders.size < 20) {
      this.log.info('Insufficient data from API, extracting from DOM')
      const domTraders = await this.extractFromDom()
      for (const t of domTraders) {
        if (!traders.has(t.traderId)) {
          traders.set(t.traderId, t)
        }
      }
    }

    // 排序并返回
    const result = Array.from(traders.values())
      .sort((a, b) => (b.roi || 0) - (a.roi || 0))
      .slice(0, this.targetCount)
      .map((t, idx) => ({ ...t, rank: idx + 1 }))

    return result
  }

  private async handleApiResponse(response: Response): Promise<void> {
    const url = response.url()
    if (
      url.includes('leaderboard') ||
      url.includes('leader-list') ||
      url.includes('copy-trad') ||
      url.includes('index/list')
    ) {
      try {
        const json = await response.json()
        const list = this.extractList(json)
        if (list.length > 0) {
          this.log.debug('Intercepted API response', { url: url.slice(0, 100), count: list.length })
          this.apiResponses.push({ url, list, timestamp: Date.now() })
        }
      } catch {
        // Ignore JSON parse errors
      }
    }
  }

  private extractList(data: Record<string, unknown>): Record<string, unknown>[] {
    if (!data) return []

    const possibleLists = [
      (data.data as Record<string, unknown>)?.items,
      (data.data as Record<string, unknown>)?.list,
      (data.data as Record<string, unknown>)?.leaders,
      data.data,
      data.list,
      data.items,
    ]

    for (const list of possibleLists) {
      if (Array.isArray(list) && list.length > 0) {
        return list as Record<string, unknown>[]
      }
    }
    return []
  }

  private parseTrader(item: Record<string, unknown>, rank: number, minDays: number): TraderData | null {
    const traderId = String(
      item.leadConfigId || item.uid || item.id || ''
    )
    if (!traderId) return null

    // Filter by days as leader
    const daysAsLeader = parseInt(String(item.daysAsLeader || 0), 10)
    if (daysAsLeader > 0 && daysAsLeader < minDays) return null

    const nickname = String(
      item.nickName || item.nickname || item.name || ''
    ) || `KuCoin_${traderId.slice(0, 8)}`

    // thirtyDayPnlRatio is in decimal (e.g. 0.5 = 50%)
    let roi = parseFloat(String(item.thirtyDayPnlRatio ?? item.totalPnlRatio ?? item.roi ?? 0))
    if (roi === 0) return null
    if (Math.abs(roi) <= 10) roi *= 100

    let winRate = parseFloat(String(item.winRatio ?? item.winRate ?? 0))
    if (winRate > 0 && winRate <= 1) winRate *= 100

    let maxDrawdown = parseFloat(String(item.maxDrawdown ?? item.mdd ?? 0))
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
    maxDrawdown = Math.abs(maxDrawdown)

    return {
      traderId,
      nickname,
      avatar: String(item.avatarUrl || item.avatar || '') || null,
      roi,
      pnl: parseFloat(String(item.totalPnl ?? item.thirtyDayPnl ?? item.totalProfit ?? 0)),
      winRate: winRate || null,
      maxDrawdown: maxDrawdown || null,
      followers: parseInt(String(item.followerCount ?? item.copierCount ?? 0), 10),
      aum: null,
      tradesCount: null,
      rank,
    }
  }

  private async switchTimePeriod(tabTexts: string[]): Promise<boolean> {
    await this.wait(2000)

    for (const tabText of tabTexts) {
      const clicked = await this.page!.evaluate((text: string) => {
        const elements = document.querySelectorAll('span, div, button, [role="tab"], [class*="tab"]')
        for (const el of elements) {
          const elText = el.textContent?.trim()
          if (elText === text || elText?.includes(text)) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0 && rect.top < 500) {
              ;(el as HTMLElement).click()
              return true
            }
          }
        }
        return false
      }, tabText)

      if (clicked) {
        this.log.info('Time period switched', { period: tabText })
        await this.wait(3000)
        this.apiResponses = []
        return true
      }
    }

    this.log.warn('Failed to switch time period')
    return false
  }

  private async extractFromDom(): Promise<TraderData[]> {
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
      const seen = new Set<string>()

      const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="leader"]')

      cards.forEach((card) => {
        const text = (card as HTMLElement).innerText || ''

        const link = card.querySelector('a[href*="trader"], a[href*="copy"]')
        const href = link?.getAttribute('href') || ''
        const idMatch = href.match(/\/(\d+)/) || href.match(/id=([^&]+)/)
        const traderId = idMatch?.[1] || `kucoin_${Date.now()}_${results.length}`

        if (seen.has(traderId)) return
        seen.add(traderId)

        const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
        let roi: number | null = null
        if (roiMatches) {
          for (const match of roiMatches) {
            const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
            if (val > 0 && (roi === null || val > roi)) {
              roi = val
            }
          }
        }

        let nickname: string | null = null
        const nameEl = card.querySelector('[class*="name"], [class*="nick"]')
        if (nameEl) {
          nickname = (nameEl as HTMLElement).innerText?.trim()?.split('\n')[0] || null
        }

        if (roi !== null && roi > 0) {
          results.push({
            traderId,
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
      })

      return results
    })

    this.log.info('Extracted from DOM', { count: pageTraders.length })
    return pageTraders
  }
}
