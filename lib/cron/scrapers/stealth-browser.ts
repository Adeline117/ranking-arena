/**
 * Stealth Browser — Anti-detection Puppeteer instance factory
 * Uses puppeteer-extra with stealth plugin to bypass WAF/Cloudflare
 */

import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import type { Browser, Page } from 'puppeteer'

puppeteerExtra.use(StealthPlugin())

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
]

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1680, height: 1050 },
]

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export interface StealthBrowserOptions {
  headless?: boolean
  proxy?: string // e.g. '127.0.0.1:7890'
  timeoutMs?: number // auto-close after this (default 60s)
}

export async function createStealthBrowser(
  opts: StealthBrowserOptions = {}
): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const { headless = true, proxy, timeoutMs = 60_000 } = opts

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-web-security',
    '--disable-dev-shm-usage',
  ]
  if (proxy) args.push(`--proxy-server=http://${proxy}`)

  const browser = await puppeteerExtra.launch({
    headless: headless ? 'new' as unknown as boolean : false,
    args,
    defaultViewport: null,
  })

  // Auto-close timer
  let timer: ReturnType<typeof setTimeout> | null = null
  const close = async () => {
    if (timer) clearTimeout(timer)
    try { await browser.close() } catch { /* already closed */ }
  }
  timer = setTimeout(() => { close() }, timeoutMs)

  return { browser, close }
}

/**
 * Configure a page with anti-fingerprinting measures
 */
export async function configurePage(page: Page): Promise<void> {
  const ua = randomItem(USER_AGENTS)
  const vp = randomItem(VIEWPORTS)

  await page.setUserAgent(ua)
  await page.setViewport(vp)

  // Override navigator properties
  await page.evaluateOnNewDocument(() => {
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

    // WebGL vendor/renderer spoofing
    const getParameter = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return 'Intel Inc.'
      if (param === 37446) return 'Intel Iris OpenGL Engine'
      return getParameter.call(this, param)
    }
  })
}

/**
 * Navigate to a URL with retry logic
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  opts: { retries?: number; waitMs?: number } = {}
): Promise<void> {
  const { retries = 3, waitMs = 5000 } = opts

  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30_000,
      })
      // Wait a bit for any JS challenges
      await new Promise((r) => setTimeout(r, waitMs))
      return
    } catch (err) {
      if (i === retries - 1) throw err
      console.warn(`[stealth-browser] Navigate attempt ${i + 1} failed, retrying...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}
