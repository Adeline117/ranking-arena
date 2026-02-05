/**
 * CoinEx Copy Trading 爬虫
 * 使用 Playwright 浏览器自动化 (DOM scraping)
 * CoinEx 没有公开 API，需要纯 DOM 提取
 */

import { Response } from 'playwright'
import { BaseScraper } from './base.js'
import type { TraderData, TimeRange } from '../types.js'

const PERIOD_CONFIG: Record<TimeRange, { tabTexts: string[] }> = {
  '7D': { tabTexts: ['7天', '7 Days', '7D', '近7天'] },
  '30D': { tabTexts: ['30天', '30 Days', '30D', '近30天'] },
  '90D': { tabTexts: ['90天', '90 Days', '90D', '近90天'] },
}

export class CoinexScraper extends BaseScraper {
  private readonly baseUrl = 'https://www.coinex.com/en/copy-trading/futures'
  private readonly targetCount = 200
  private apiResponses: Array<{ url: string; list: Record<string, unknown>[]; timestamp: number }> = []

  constructor() {
    super('coinex')
  }

  protected async scrapeData(timeRange: TimeRange): Promise<TraderData[]> {
    const config = PERIOD_CONFIG[timeRange]
    const traders = new Map<string, TraderData>()

    this.log.info('Starting CoinEx scrape', {
      timeRange,
      targetCount: this.targetCount,
    })

    // 设置 API 响应拦截器 (尝试捕获任何 API)
    this.page!.on('response', (response: Response) => this.handleApiResponse(response))

    // 访问页面
    try {
      await this.navigateWithRetry(this.baseUrl)
    } catch (error) {
      this.log.warn('Initial page load timeout, continuing', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    await this.wait(6000)

    // 切换时间周期
    this.log.info('Switching time period', { timeRange })
    await this.switchTimePeriod(config.tabTexts)

    // 滚动加载更多数据
    for (let scroll = 0; scroll < 15; scroll++) {
      await this.page!.evaluate(() => window.scrollBy(0, 500))
      await this.wait(2000)

      // 处理任何可能拦截到的 API 响应
      const recentResponses = this.apiResponses.filter(r => r.timestamp > Date.now() - 15000)
      for (const { list } of recentResponses) {
        list.forEach((item, idx) => {
          const trader = this.parseTraderFromApi(item, traders.size + idx + 1)
          if (trader && trader.traderId && !traders.has(trader.traderId)) {
            traders.set(trader.traderId, trader)
          }
        })
      }

      // 主要通过 DOM 提取
      const domTraders = await this.extractFromDom()
      for (const t of domTraders) {
        if (!traders.has(t.traderId)) {
          traders.set(t.traderId, t)
        }
      }

      this.log.debug('Current traders count', { count: traders.size })

      if (traders.size >= this.targetCount) {
        this.log.info('Target count reached', { count: traders.size })
        break
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
      url.includes('copy') ||
      url.includes('trader') ||
      url.includes('leader') ||
      url.includes('rank')
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
      (data.data as Record<string, unknown>)?.list,
      (data.data as Record<string, unknown>)?.items,
      (data.data as Record<string, unknown>)?.traders,
      (data.data as Record<string, unknown>)?.rows,
      data.data,
      data.list,
    ]

    for (const list of possibleLists) {
      if (Array.isArray(list) && list.length > 0) {
        return list as Record<string, unknown>[]
      }
    }
    return []
  }

  private parseTraderFromApi(item: Record<string, unknown>, rank: number): TraderData | null {
    const traderId = String(
      item.trader_id || item.traderId || item.uid || item.id || ''
    )
    if (!traderId) return null

    const nickname = String(
      item.nick_name || item.nickName || item.nickname || item.name || ''
    )
    if (!nickname) return null

    let roi = parseFloat(String(item.roi ?? item.roi_rate ?? item.return_rate ?? 0))
    if (roi === 0) return null
    if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

    let winRate = parseFloat(String(item.win_rate ?? item.winRate ?? 0))
    if (winRate > 0 && winRate <= 1) winRate *= 100

    let maxDrawdown = parseFloat(String(item.max_drawdown ?? item.maxDrawdown ?? item.mdd ?? 0))
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
    maxDrawdown = Math.abs(maxDrawdown)

    return {
      traderId,
      nickname,
      avatar: String(item.avatar || item.avatar_url || '') || null,
      roi,
      pnl: parseFloat(String(item.pnl ?? item.profit ?? item.total_pnl ?? 0)),
      winRate: winRate || null,
      maxDrawdown: maxDrawdown || null,
      followers: parseInt(String(item.follower_count ?? item.followerCount ?? item.copier_num ?? 0), 10),
      aum: null,
      tradesCount: null,
      rank,
    }
  }

  private async switchTimePeriod(tabTexts: string[]): Promise<boolean> {
    await this.wait(2000)

    for (const tabText of tabTexts) {
      const clicked = await this.page!.evaluate((text: string) => {
        const elements = document.querySelectorAll('span, div, button, [role="tab"], [class*="tab"], [class*="filter"]')
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

      // CoinEx uses various card patterns
      const cards = document.querySelectorAll(
        '[class*="trader"], [class*="card"], [class*="item"], [class*="leader"], [class*="row"]'
      )

      cards.forEach((card) => {
        const text = (card as HTMLElement).innerText || ''

        // Skip headers and non-trader rows
        if (text.includes('收益率') || text.includes('ROI') || text.length < 10) return

        // Try to extract trader ID from link
        const link = card.querySelector('a[href*="trader"], a[href*="copy"], a[href*="detail"]')
        const href = link?.getAttribute('href') || ''
        const idMatch = href.match(/\/(\d+)/) || href.match(/id=([^&]+)/) || href.match(/trader\/([^/]+)/)
        const traderId = idMatch?.[1] || `coinex_${Date.now()}_${results.length}`

        if (seen.has(traderId)) return
        seen.add(traderId)

        // Extract ROI - look for percentage values
        const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g)
        let roi: number | null = null
        if (roiMatches) {
          for (const match of roiMatches) {
            const val = parseFloat(match.replace(/[^0-9.+-]/g, ''))
            // Take the largest positive ROI (likely the main metric)
            if (val > 0 && (roi === null || val > roi)) {
              roi = val
            }
          }
        }

        // Extract nickname
        let nickname: string | null = null
        const nameEl = card.querySelector('[class*="name"], [class*="nick"], [class*="user"]')
        if (nameEl) {
          nickname = (nameEl as HTMLElement).innerText?.trim()?.split('\n')[0] || null
        }

        // Extract win rate
        let winRate: number | null = null
        const wrMatch = text.match(/(?:胜率|Win Rate|WR)[:\s]*(\d+(?:\.\d+)?)\s*%/i)
        if (wrMatch) {
          winRate = parseFloat(wrMatch[1])
        }

        // Extract max drawdown
        let maxDrawdown: number | null = null
        const ddMatch = text.match(/(?:回撤|Drawdown|MDD)[:\s]*(\d+(?:\.\d+)?)\s*%/i)
        if (ddMatch) {
          maxDrawdown = parseFloat(ddMatch[1])
        }

        // Extract followers
        let followers = 0
        const followerMatch = text.match(/(\d+)\s*(?:跟单|followers|copiers)/i)
        if (followerMatch) {
          followers = parseInt(followerMatch[1], 10)
        }

        if (roi !== null && roi > 0) {
          results.push({
            traderId,
            nickname,
            avatar: null,
            roi,
            pnl: 0,
            winRate,
            maxDrawdown,
            followers,
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
