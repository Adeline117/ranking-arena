/**
 * 爬虫基础类
 * 提供通用的浏览器自动化和错误处理
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { logger, withRetry, sleep } from '../logger.js'
import type { TraderData, DataSource, TimeRange, ScrapeResult, ScraperOptions } from '../types.js'

export abstract class BaseScraper {
  protected source: DataSource
  protected options: Required<ScraperOptions>
  protected browser: Browser | null = null
  protected context: BrowserContext | null = null
  protected page: Page | null = null
  protected log: ReturnType<typeof logger.withContext>

  constructor(source: DataSource, options: ScraperOptions = {}) {
    this.source = source
    this.options = {
      headless: options.headless ?? true,
      timeout: options.timeout ?? 60000,
      retries: options.retries ?? 3,
    }
    this.log = logger.withContext({ source })
  }

  /**
   * 初始化浏览器
   */
  protected async initBrowser(): Promise<void> {
    this.log.info('Initializing browser')

    this.browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    })

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })

    // 添加反检测脚本
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      // @ts-expect-error - Adding chrome property for detection bypass
      window.chrome = { runtime: {} }
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
      })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    })

    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(this.options.timeout)
  }

  /**
   * 关闭浏览器
   */
  protected async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      this.context = null
      this.page = null
      this.log.info('Browser closed')
    }
  }

  /**
   * 安全等待
   */
  protected async wait(ms: number): Promise<void> {
    await sleep(ms)
  }

  /**
   * 安全点击元素
   */
  protected async safeClick(selector: string, description: string): Promise<boolean> {
    if (!this.page) return false

    try {
      const element = this.page.locator(selector).first()
      if ((await element.count()) > 0) {
        await element.click()
        this.log.debug(`Clicked: ${description}`)
        return true
      }
    } catch (error) {
      this.log.debug(`Click failed: ${description}`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return false
  }

  /**
   * 带重试的页面导航
   */
  protected async navigateWithRetry(url: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized')

    await withRetry(
      async () => {
        await this.page!.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.timeout,
        })
      },
      {
        maxRetries: this.options.retries,
        context: `Navigate to ${url}`,
      }
    )
  }

  /**
   * 截图保存（用于调试）
   */
  protected async takeScreenshot(name: string): Promise<string | null> {
    if (!this.page) return null

    try {
      const path = `/tmp/${this.source}_${name}_${Date.now()}.png`
      await this.page.screenshot({ path, fullPage: true })
      this.log.debug('Screenshot saved', { path })
      return path
    } catch (error) {
      this.log.warn('Screenshot failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * 抽象方法：执行实际的数据抓取
   */
  protected abstract scrapeData(timeRange: TimeRange): Promise<TraderData[]>

  /**
   * 执行抓取（带完整的生命周期管理）
   */
  async scrape(timeRange: TimeRange): Promise<ScrapeResult> {
    const startTime = Date.now()
    this.log.info('Starting scrape', { timeRange })

    try {
      await this.initBrowser()
      const traders = await this.scrapeData(timeRange)

      const duration = Date.now() - startTime
      this.log.info('Scrape completed', {
        timeRange,
        tradersCount: traders.length,
        duration,
      })

      return {
        source: this.source,
        timeRange,
        traders,
        scrapedAt: new Date().toISOString(),
        duration,
        success: true,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      const duration = Date.now() - startTime

      this.log.error('Scrape failed', err, { timeRange, duration })

      // 保存失败截图
      await this.takeScreenshot(`error_${timeRange}`)

      return {
        source: this.source,
        timeRange,
        traders: [],
        scrapedAt: new Date().toISOString(),
        duration,
        success: false,
        error: err.message,
      }
    } finally {
      await this.closeBrowser()
    }
  }
}

/**
 * 从 API 响应中解析交易员数据的通用函数
 */
export function parseTraderFromApi(
  item: Record<string, unknown>,
  rank: number
): TraderData | null {
  const traderId = String(
    item.portfolioId || item.encryptedUid || item.leadPortfolioId || item.uid || ''
  )
  if (!traderId) return null

  let roi = parseFloat(String(item.roi ?? item.roiPct ?? item.roiRate ?? 0))
  // 如果 ROI 是小数形式（如 0.25 表示 25%），转换为百分比
  if (roi > 0 && roi < 10) {
    roi = roi * 100
  }

  return {
    traderId,
    nickname: String(item.nickName || item.nickname || item.displayName || '') || null,
    avatar: String(item.userPhoto || item.avatar || item.avatarUrl || '') || null,
    roi,
    pnl: parseFloat(String(item.pnl ?? item.profit ?? item.totalProfit ?? 0)),
    winRate: item.winRate != null ? parseFloat(String(item.winRate ?? item.winRatio ?? 0)) : null,
    maxDrawdown: item.mdd != null ? parseFloat(String(item.mdd ?? item.maxDrawdown ?? 0)) : null,
    followers: parseInt(String(item.copierCount ?? item.followerCount ?? item.followers ?? 0), 10),
    aum: item.aum != null ? parseFloat(String(item.aum ?? item.totalAsset ?? 0)) : null,
    tradesCount: item.tradesCount != null ? parseInt(String(item.tradesCount), 10) : null,
    rank,
  }
}
