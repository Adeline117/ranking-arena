/**
 * VPS Playwright Scraper — Multi-exchange copy trading support
 *
 * Adds endpoints for exchanges blocked by Cloudflare/Akamai WAF:
 *   GET /mexc/leaderboard?periodType=2&pageSize=50
 *   GET /coinex/leaderboard?period=30d&pageSize=50
 *   GET /kucoin/leaderboard?period=30&pageSize=20
 *   GET /lbank/leaderboard?pageSize=50
 *   GET /bingx/leaderboard?timeType=2&pageSize=50
 *
 * Deployment: copy to VPS at /opt/scraper/exchanges.js
 * Then add routes in /opt/scraper/server.js
 *
 * Requires: playwright (already installed on VPS for Bybit scraper)
 */

const { chromium } = require('playwright')

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
]

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: BROWSER_ARGS,
  })
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

// ─── MEXC ────────────────────────────────────────────────────────
// Browse www.mexc.com/futures/copyTrade/home and intercept API responses
async function scrapeMexc({ periodType = 2, pageSize = 50 } = {}) {
  return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const captured = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy-trade') && url.includes('rank')) {
        try {
          const data = await response.json()
          captured.push(data)
        } catch {}
      }
    })

    await page.goto('https://www.mexc.com/futures/copyTrade/home', { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(3000)

    // Try to trigger the leaderboard API by interacting with the page
    // The page loads the default leaderboard automatically
    await page.waitForTimeout(5000)

    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  })
}

// ─── CoinEx ────────────────────────────────────────────────────────
async function scrapeCoinex({ period = '30d', pageSize = 50 } = {}) {
  return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const captured = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy') && (url.includes('rank') || url.includes('trader'))) {
        try {
          const data = await response.json()
          captured.push(data)
        } catch {}
      }
    })

    await page.goto('https://www.coinex.com/en/copy-trading/futures', { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(5000)

    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  })
}

// ─── KuCoin ────────────────────────────────────────────────────────
async function scrapeKucoin({ period = '30', pageSize = 20 } = {}) {
  return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const captured = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy-trade') && (url.includes('leader') || url.includes('rank'))) {
        try {
          const data = await response.json()
          captured.push(data)
        } catch {}
      }
    })

    await page.goto('https://www.kucoin.com/copy-trading', { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(5000)

    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  })
}

// ─── LBank ────────────────────────────────────────────────────────
async function scrapeLbank({ pageSize = 50 } = {}) {
  return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const captured = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy') && (url.includes('trader') || url.includes('leader') || url.includes('rank'))) {
        try {
          const data = await response.json()
          captured.push(data)
        } catch {}
      }
    })

    await page.goto('https://www.lbank.com/copy-trading', { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(5000)

    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  })
}

// ─── BingX ────────────────────────────────────────────────────────
async function scrapeBingx({ timeType = 2, pageSize = 50 } = {}) {
  return withBrowser(async (browser) => {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const captured = []

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('copy') && (url.includes('leaderboard') || url.includes('ranking') || url.includes('rank'))) {
        try {
          const data = await response.json()
          captured.push(data)
        } catch {}
      }
    })

    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(5000)

    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  })
}

module.exports = { scrapeMexc, scrapeCoinex, scrapeKucoin, scrapeLbank, scrapeBingx }
