/**
 * 爬虫基础类
 * 提供通用的浏览器自动化和错误处理
 * 支持代理池轮换
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright'
import { logger, withRetry, sleep } from '../logger.js'
import type { TraderData, DataSource, TimeRange, ScrapeResult, ScraperOptions } from '../types.js'

/**
 * 代理配置
 */
interface ProxyConfig {
  server: string
  username?: string
  password?: string
}

/**
 * 代理池管理器
 */
class ProxyPool {
  private proxies: ProxyConfig[] = []
  private currentIndex = 0
  private failedProxies = new Set<string>()

  constructor() {
    this.loadProxiesFromEnv()
  }

  /**
   * 从环境变量加载代理列表
   * 格式: PROXY_LIST=server1|user1|pass1,server2|user2|pass2
   * 或简单格式: PROXY_LIST=http://proxy1:port,http://proxy2:port
   */
  private loadProxiesFromEnv(): void {
    const proxyList = process.env.PROXY_LIST
    if (!proxyList) {
      return
    }

    const proxyStrings = proxyList.split(',').map(s => s.trim()).filter(Boolean)
    
    for (const proxyStr of proxyStrings) {
      const parts = proxyStr.split('|')
      if (parts.length >= 1) {
        this.proxies.push({
          server: parts[0],
          username: parts[1] || undefined,
          password: parts[2] || undefined,
        })
      }
    }

    if (this.proxies.length > 0) {
      logger.info('Proxy pool initialized', { count: this.proxies.length })
    }
  }

  /**
   * 获取下一个可用的代理
   */
  getNextProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null
    }

    // 找到一个未失败的代理
    let attempts = 0
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex]
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length

      if (!this.failedProxies.has(proxy.server)) {
        logger.debug('Using proxy', { server: proxy.server })
        return proxy
      }

      attempts++
    }

    // 如果所有代理都失败了，重置失败列表再试一次
    if (this.failedProxies.size > 0) {
      logger.warn('All proxies failed, resetting failed list')
      this.failedProxies.clear()
      return this.proxies[0]
    }

    return null
  }

  /**
   * 标记代理为失败
   */
  markProxyFailed(proxy: ProxyConfig): void {
    this.failedProxies.add(proxy.server)
    logger.warn('Proxy marked as failed', { 
      server: proxy.server,
      failedCount: this.failedProxies.size,
      totalCount: this.proxies.length,
    })
  }

  /**
   * 是否有可用代理
   */
  hasProxies(): boolean {
    return this.proxies.length > 0
  }

  /**
   * 获取代理池状态
   */
  getStats(): { total: number; failed: number; available: number } {
    return {
      total: this.proxies.length,
      failed: this.failedProxies.size,
      available: this.proxies.length - this.failedProxies.size,
    }
  }
}

// 全局代理池实例
const proxyPool = new ProxyPool()

/**
 * 获取代理池状态
 */
export function getProxyPoolStats() {
  return proxyPool.getStats()
}

export abstract class BaseScraper {
  protected source: DataSource
  protected options: Required<ScraperOptions>
  protected browser: Browser | null = null
  protected context: BrowserContext | null = null
  protected page: Page | null = null
  protected log: ReturnType<typeof logger.withContext>
  protected currentProxy: ProxyConfig | null = null

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
   * 获取下一个代理
   */
  protected getNextProxy(): ProxyConfig | null {
    return proxyPool.getNextProxy()
  }

  /**
   * 标记当前代理为失败
   */
  protected markCurrentProxyFailed(): void {
    if (this.currentProxy) {
      proxyPool.markProxyFailed(this.currentProxy)
    }
  }

  /**
   * 初始化浏览器
   */
  protected async initBrowser(): Promise<void> {
    // 获取代理（如果可用）
    this.currentProxy = this.getNextProxy()

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: this.options.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    }

    // 如果有代理，添加代理配置
    if (this.currentProxy) {
      this.log.info('Initializing browser with proxy', { 
        server: this.currentProxy.server,
      })
      launchOptions.proxy = {
        server: this.currentProxy.server,
        username: this.currentProxy.username,
        password: this.currentProxy.password,
      }
    } else {
      this.log.info('Initializing browser without proxy')
    }

    this.browser = await chromium.launch(launchOptions)

    // 随机化 User-Agent
    const userAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ]
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)]

    this.context = await this.browser.newContext({
      userAgent,
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
   * 添加随机延迟（降低被检测风险）
   */
  protected async randomDelay(minMs: number = 1000, maxMs: number = 3000): Promise<void> {
    const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs
    await sleep(delay)
  }

  /**
   * 执行抓取（带完整的生命周期管理）
   * 支持代理失败重试
   */
  async scrape(timeRange: TimeRange): Promise<ScrapeResult> {
    const startTime = Date.now()
    this.log.info('Starting scrape', { 
      timeRange,
      proxyAvailable: proxyPool.hasProxies(),
    })

    let lastError: Error | null = null
    const maxProxyRetries = proxyPool.hasProxies() ? 3 : 1

    for (let attempt = 1; attempt <= maxProxyRetries; attempt++) {
      try {
        await this.initBrowser()
        
        // 添加随机延迟
        await this.randomDelay(2000, 5000)
        
        const traders = await this.scrapeData(timeRange)

        const duration = Date.now() - startTime
        this.log.info('Scrape completed', {
          timeRange,
          tradersCount: traders.length,
          duration,
          proxyUsed: this.currentProxy?.server || 'none',
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
        lastError = error instanceof Error ? error : new Error(String(error))
        
        this.log.error('Scrape attempt failed', lastError, { 
          timeRange, 
          attempt,
          maxAttempts: maxProxyRetries,
          proxyUsed: this.currentProxy?.server || 'none',
        })

        // 如果使用了代理且失败，标记代理为失败
        if (this.currentProxy) {
          this.markCurrentProxyFailed()
        }

        // 保存失败截图
        await this.takeScreenshot(`error_${timeRange}_attempt${attempt}`)

        // 如果还有重试机会，等待后重试
        if (attempt < maxProxyRetries) {
          this.log.info('Retrying with different proxy', { 
            attempt: attempt + 1,
            maxAttempts: maxProxyRetries,
          })
          await sleep(5000) // 等待 5 秒后重试
        }
      } finally {
        await this.closeBrowser()
      }
    }

    // 所有重试都失败
    const duration = Date.now() - startTime
    return {
      source: this.source,
      timeRange,
      traders: [],
      scrapedAt: new Date().toISOString(),
      duration,
      success: false,
      error: lastError?.message || 'Unknown error',
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
