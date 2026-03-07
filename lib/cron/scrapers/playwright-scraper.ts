/**
 * Playwright Scraper — High-performance browser automation with stealth
 * 
 * Improvements over existing stealth-browser.ts:
 * - Uses Playwright instead of Puppeteer (faster, more stable)
 * - Better WAF bypass with randomized fingerprints
 * - Built-in response interception
 * - Connection pooling for batch operations
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright'
import { logger } from '@/lib/logger'

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
]

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export interface ScraperOptions {
  headless?: boolean
  timeoutMs?: number
  userAgent?: string
  viewport?: { width: number; height: number }
}

/**
 * Create a stealth browser instance with anti-detection measures
 */
export async function createBrowser(opts: ScraperOptions = {}): Promise<Browser> {
  const { headless = true } = opts

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-gpu',
    ],
  })

  return browser
}

/**
 * Create a stealth context with randomized fingerprint
 */
export async function createStealthContext(
  browser: Browser,
  opts: ScraperOptions = {}
): Promise<BrowserContext> {
  const userAgent = opts.userAgent || randomItem(USER_AGENTS)
  const viewport = opts.viewport || randomItem(VIEWPORTS)

  const context = await browser.newContext({
    userAgent,
    viewport,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Add some randomness to avoid fingerprinting
    permissions: [],
    colorScheme: Math.random() > 0.5 ? 'dark' : 'light',
  })

  // Add anti-detection scripts
  await context.addInitScript(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    
    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    })
    
    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query
    window.navigator.permissions.query = (parameters: any) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: 'denied' } as PermissionStatus)
        : originalQuery(parameters)
    
    // WebGL fingerprint randomization
    const getParameter = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return 'Intel Inc.'
      if (param === 37446) return 'Intel Iris OpenGL Engine'
      return getParameter.call(this, param)
    }
  })

  return context
}

/**
 * Navigate to URL with retry and Cloudflare bypass
 */
export async function navigateStealth(
  page: Page,
  url: string,
  opts: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number } = {}
): Promise<void> {
  const { waitUntil = 'networkidle', timeout = 30000 } = opts

  try {
    await page.goto(url, { waitUntil, timeout })
    
    // Check for Cloudflare challenge
    const content = await page.content()
    const isChallenged =
      content.includes('cf-challenge') ||
      content.includes('challenge-platform') ||
      content.includes('Just a moment') ||
      content.includes('Checking your browser')

    if (isChallenged) {
      logger.info('[playwright-scraper] Cloudflare challenge detected, waiting...')
      // Wait for challenge to resolve (max 30s)
      await page.waitForFunction(
        () => {
          const body = document.body?.innerText || ''
          return (
            !body.includes('Just a moment') &&
            !body.includes('Checking your browser')
          )
        },
        { timeout: 30000 }
      ).catch(() => {
        logger.warn('[playwright-scraper] Cloudflare challenge timeout')
      })
      
      // Extra settle time
      await page.waitForTimeout(2000)
    }
  } catch (err) {
    logger.error(`[playwright-scraper] Navigation failed: ${err instanceof Error ? err.message : err}`)
    throw err
  }
}

/**
 * Intercept API responses by URL pattern
 */
export async function interceptApiResponses(
  page: Page,
  urlPatterns: string[],
  opts: { maxWaitMs?: number } = {}
): Promise<Array<{ url: string; body: any }>> {
  const { maxWaitMs = 10000 } = opts
  const responses: Array<{ url: string; body: any }> = []

  page.on('response', async (response) => {
    const url = response.url()
    if (urlPatterns.some((p) => url.includes(p))) {
      try {
        const body = await response.json()
        responses.push({ url, body })
      } catch {
        // Not JSON or failed to parse
      }
    }
  })

  // Wait for responses
  const deadline = Date.now() + maxWaitMs
  while (responses.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(1000)
  }

  return responses
}

/**
 * Extract data from page using selector
 */
export async function extractData<T = any>(
  page: Page,
  selector: string,
  extractor: (element: any) => T
): Promise<T[]> {
  return page.$$eval(selector, (elements, extractorStr) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('element', `return (${extractorStr})(element)`)
    return elements.map((el) => fn(el))
  }, extractor.toString())
}

/**
 * Browser pool for batch operations
 */
export class BrowserPool {
  private browsers: Browser[] = []
  private maxBrowsers: number

  constructor(maxBrowsers = 3) {
    this.maxBrowsers = maxBrowsers
  }

  async getBrowser(): Promise<Browser> {
    if (this.browsers.length < this.maxBrowsers) {
      const browser = await createBrowser()
      this.browsers.push(browser)
      return browser
    }
    return this.browsers[Math.floor(Math.random() * this.browsers.length)]
  }

  async close(): Promise<void> {
    await Promise.all(this.browsers.map((b) => b.close()))
    this.browsers = []
  }
}
