#!/usr/bin/env node
/**
 * VPS Playwright Scraper v16 — Parallel Browser Contexts
 *
 * Key changes from v15 (serial):
 * - Single shared browser, pool of 2-3 browser contexts (isolated cookies/state)
 * - Concurrent request processing up to pool size
 * - /health endpoint shows busy contexts, queue depth, active requests
 * - Memory target: <500MB total (shared browser, no per-request browser launch)
 *
 * Deployment:
 *   scp scraper-v16-parallel.js VPS:/opt/scraper/server.js
 *   pm2 restart arena-scraper
 *
 * Requires: playwright (chromium only)
 */

const http = require('http')
const { chromium } = require('playwright')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.SCRAPER_PORT || '3457', 10)
const PROXY_KEY = process.env.PROXY_KEY || 'arena-proxy-sg-2026'
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '3', 10)
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT || '90000', 10)
const VERSION = '16.0.0'

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  '--js-flags=--max-old-space-size=256',
]

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {import('playwright').Browser | null} */
let browser = null

/** @type {{ context: import('playwright').BrowserContext, busy: boolean, id: number }[]} */
let contextPool = []

/** @type {{ handler: string, params: Record<string,string>, resolve: Function, reject: Function, enqueuedAt: number }[]} */
const requestQueue = []

let totalRequests = 0
let totalErrors = 0
let activeRequests = 0
const startedAt = new Date().toISOString()

// ---------------------------------------------------------------------------
// Browser & Context Pool Management
// ---------------------------------------------------------------------------

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser

  log('Launching browser...')
  browser = await chromium.launch({
    headless: true,
    args: BROWSER_ARGS,
  })

  browser.on('disconnected', () => {
    log('Browser disconnected — will relaunch on next request')
    browser = null
    contextPool = []
  })

  // Pre-create context pool
  contextPool = []
  for (let i = 0; i < POOL_SIZE; i++) {
    const context = await browser.newContext({
      userAgent: DEFAULT_UA,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    })
    contextPool.push({ context, busy: false, id: i })
  }

  log(`Browser launched, ${POOL_SIZE} contexts created`)
  return browser
}

/**
 * Acquire a free context from the pool. Returns null if all busy.
 */
function acquireContext() {
  for (const slot of contextPool) {
    if (!slot.busy) {
      slot.busy = true
      return slot
    }
  }
  return null
}

function releaseContext(slot) {
  slot.busy = true // keep true until we recycle
  // Create a fresh context to clear cookies/state from this request
  recycleContext(slot).catch((err) => {
    log(`Context ${slot.id} recycle error: ${err.message}`)
  })
}

async function recycleContext(slot) {
  try {
    // Close all pages in this context
    const pages = slot.context.pages()
    for (const page of pages) {
      await page.close().catch(() => {})
    }
    // Clear cookies/storage for isolation
    await slot.context.clearCookies().catch(() => {})
  } catch {
    // If clearing fails, create a fresh context
    try {
      await slot.context.close().catch(() => {})
      if (browser && browser.isConnected()) {
        slot.context = await browser.newContext({
          userAgent: DEFAULT_UA,
          viewport: { width: 1280, height: 720 },
          ignoreHTTPSErrors: true,
        })
      }
    } catch (err) {
      log(`Context ${slot.id} full recycle failed: ${err.message}`)
    }
  } finally {
    slot.busy = false
    // Process next queued request
    processQueue()
  }
}

// ---------------------------------------------------------------------------
// Request Queue
// ---------------------------------------------------------------------------

function enqueue(handler, params) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ handler, params, resolve, reject, enqueuedAt: Date.now() })
    processQueue()
  })
}

function processQueue() {
  while (requestQueue.length > 0) {
    const slot = acquireContext()
    if (!slot) break // All contexts busy

    const item = requestQueue.shift()
    if (!item) break

    const queueWaitMs = Date.now() - item.enqueuedAt
    if (queueWaitMs > REQUEST_TIMEOUT_MS) {
      item.reject(new Error(`Request timed out in queue after ${queueWaitMs}ms`))
      releaseContext(slot)
      continue
    }

    activeRequests++
    executeRequest(slot, item)
      .then((result) => {
        activeRequests--
        item.resolve(result)
      })
      .catch((err) => {
        activeRequests--
        item.reject(err)
      })
      .finally(() => {
        releaseContext(slot)
      })
  }
}

async function executeRequest(slot, item) {
  const { handler, params } = item

  // Per-request timeout
  const timeout = setTimeout(() => {
    // Force-close pages to abort hung navigations
    const pages = slot.context.pages()
    for (const page of pages) {
      page.close().catch(() => {})
    }
  }, REQUEST_TIMEOUT_MS)

  try {
    const handlerFn = HANDLERS[handler]
    if (!handlerFn) throw new Error(`Unknown handler: ${handler}`)

    const page = await slot.context.newPage()
    try {
      const result = await handlerFn(page, params)
      return result
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Exchange Handlers
// ---------------------------------------------------------------------------

/**
 * Setup API response interception on a page.
 * Returns a function that returns all captured responses matching the filter.
 */
function setupInterception(page, urlFilter) {
  const captured = []

  page.on('response', async (response) => {
    const url = response.url()
    if (urlFilter(url)) {
      try {
        const text = await response.text()
        try {
          captured.push(JSON.parse(text))
        } catch {
          // Not JSON, skip
        }
      } catch {
        // Response body consumed or network error
      }
    }
  })

  return () => captured
}

/**
 * Try fetching JSON directly from page context (bypasses WAF).
 */
async function safeFetchJson(page, url, options = {}) {
  try {
    return await page.evaluate(
      async ({ url, options }) => {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', ...options.headers },
          ...options,
        })
        if (!res.ok) return null
        return await res.json()
      },
      { url, options }
    )
  } catch {
    return null
  }
}

const HANDLERS = {
  // ─── Bybit ────────────────────────────────────────────────────────
  'bybit/leaderboard': async (page, params) => {
    const duration = params.dataDuration || 'DATA_DURATION_THIRTY_DAY'
    const pageSize = parseInt(params.pageSize || '50', 10)

    const getCaptured = setupInterception(page, (url) =>
      url.includes('leaderboard') && (url.includes('rank') || url.includes('leader'))
    )

    await page.goto('https://www.bybitglobal.com/en/copy-trading/leaderboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(3000)

    // Try direct API fetch from page context
    const apiData = await safeFetchJson(
      page,
      `https://api2.bybitglobal.com/fapi/beehive/public/v1/common/dynamic-leader-list`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataDuration: duration,
          pageNo: '1',
          pageSize: String(pageSize),
          sortField: 'ROI',
          sortType: 'DESC',
        }),
      }
    )

    if (apiData && (apiData.result?.data?.length > 0 || apiData.result?.leaderDetails?.length > 0)) {
      return apiData
    }

    // Fallback to intercepted responses
    await page.waitForTimeout(5000)
    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  'bybit/leaderboard-batch': async (page, params) => {
    const durations = (params.durations || 'DATA_DURATION_THIRTY_DAY').split(',')
    const pageSize = parseInt(params.pageSize || '50', 10)
    const results = {}

    // Navigate once, then fetch all periods from page context
    await page.goto('https://www.bybitglobal.com/en/copy-trading/leaderboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(3000)

    for (const duration of durations) {
      const apiData = await safeFetchJson(
        page,
        'https://api2.bybitglobal.com/fapi/beehive/public/v1/common/dynamic-leader-list',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataDuration: duration.trim(),
            pageNo: '1',
            pageSize: String(pageSize),
            sortField: 'ROI',
            sortType: 'DESC',
          }),
        }
      )
      results[duration.trim()] = apiData || { error: 'fetch failed' }
      // Small delay between period fetches
      await page.waitForTimeout(500)
    }

    return results
  },

  // ─── Bitget ────────────────────────────────────────────────────────
  'bitget/leaderboard': async (page, params) => {
    const period = params.period || 'THIRTY_DAYS'
    const pageSize = parseInt(params.pageSize || '100', 10)

    const getCaptured = setupInterception(page, (url) =>
      url.includes('trace') && (url.includes('traderList') || url.includes('trader'))
    )

    await page.goto('https://www.bitget.com/copy-trading', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(3000)

    // Direct API fetch
    const apiData = await safeFetchJson(
      page,
      `https://www.bitget.com/v1/trigger/trace/public/traderList?languageType=1&pageSize=${pageSize}&pageNo=1&periodType=${period}&sortBy=ROI&sortType=DESC`
    )

    if (apiData?.data?.traderList?.length > 0) return apiData

    await page.waitForTimeout(5000)
    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  // ─── Gate.io ────────────────────────────────────────────────────────
  'gateio/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    const getCaptured = setupInterception(page, (url) =>
      url.includes('apiw') && url.includes('copy') && url.includes('leader')
    )

    await page.goto('https://www.gate.com/copy-trading', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(3000)

    // Direct API
    const apiData = await safeFetchJson(
      page,
      `https://www.gate.com/apiw/v2/copy/leader/list?page=1&limit=${pageSize}&sort_by=profit_rate&sort_type=desc`
    )

    if (apiData?.data?.list?.length > 0) return apiData

    await page.waitForTimeout(5000)
    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  // ─── MEXC ────────────────────────────────────────────────────────
  'mexc/leaderboard': async (page, params) => {
    const periodType = params.periodType || '2'

    const getCaptured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('rank') || url.includes('trader'))
    )

    await page.goto('https://www.mexc.com/futures/copyTrade/home', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(5000)

    // Direct API
    const apiData = await safeFetchJson(
      page,
      `https://futures.mexc.com/api/v1/copyFutures/api/v1/traders/top?pageNo=1&pageSize=50&periodType=${periodType}`
    )

    if (apiData?.data) return apiData

    await page.waitForTimeout(3000)
    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  // ─── CoinEx ────────────────────────────────────────────────────────
  'coinex/leaderboard': async (page, params) => {
    const getCaptured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('rank') || url.includes('trader'))
    )

    await page.goto('https://www.coinex.com/en/copy-trading/futures', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(5000)

    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  // ─── BingX ────────────────────────────────────────────────────────
  'bingx/leaderboard': async (page, params) => {
    const timeType = params.timeType || '2'

    const getCaptured = setupInterception(page, (url) =>
      url.includes('multi-rank') || (url.includes('copy') && url.includes('rank'))
    )

    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })

    // Scroll early to trigger SPA API calls
    await page.evaluate(() => window.scrollBy(0, 500))
    await page.waitForTimeout(2000)

    // Wait for multi-rank response
    try {
      await page.waitForResponse(
        (response) => response.url().includes('multi-rank'),
        { timeout: 15000 }
      )
    } catch {
      // Timeout waiting for response — check captured
    }

    await page.waitForTimeout(2000)
    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  // ─── BloFin ────────────────────────────────────────────────────────
  'blofin/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    // BloFin has a public API, try direct fetch first
    const getCaptured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('trader') || url.includes('rank'))
    )

    await page.goto('https://www.blofin.com/copy-trading', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(3000)

    // Try direct API from page context
    const apiData = await safeFetchJson(
      page,
      `https://openapi.blofin.com/api/v1/copy-trading/public/current-traders?pageSize=${pageSize}&pageNo=1&sortBy=pnl&sortType=desc`
    )

    if (apiData?.data?.length > 0) return apiData

    await page.waitForTimeout(5000)
    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },

  // ─── Bitunix ────────────────────────────────────────────────────────
  'bitunix/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    const getCaptured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('trader') || url.includes('rank') || url.includes('leader'))
    )

    await page.goto('https://www.bitunix.com/copy-trading', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(3000)

    // Scroll to trigger lazy-loaded content
    await page.evaluate(() => window.scrollBy(0, 500))
    await page.waitForTimeout(3000)

    // Try direct API from page context
    if (getCaptured().length === 0) {
      const apiData = await safeFetchJson(page, `/api/v1/copy-trade/traders?page=1&pageSize=${pageSize}&sortType=2`)
      if (apiData) return apiData
    }

    const captured = getCaptured()
    return captured.length > 0 ? captured[0] : { error: 'No API response captured' }
  },
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = url.pathname

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'X-Proxy-Key, Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Health endpoint (no auth)
  if (pathname === '/health') {
    const busyContexts = contextPool.filter((s) => s.busy).length
    const memUsage = process.memoryUsage()

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'ok',
        version: VERSION,
        uptime: process.uptime(),
        startedAt,
        pool: {
          size: contextPool.length,
          busy: busyContexts,
          free: contextPool.length - busyContexts,
        },
        queue: requestQueue.length,
        active: activeRequests,
        stats: {
          totalRequests,
          totalErrors,
        },
        memory: {
          rss: Math.round(memUsage.rss / 1024 / 1024),
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        browserConnected: browser ? browser.isConnected() : false,
      })
    )
    return
  }

  // Auth check
  if (req.headers['x-proxy-key'] !== PROXY_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // Route to handler
  // Strip leading slash: /bybit/leaderboard -> bybit/leaderboard
  const handlerName = pathname.replace(/^\//, '')

  if (!HANDLERS[handlerName]) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: `Unknown endpoint: ${pathname}`,
        available: Object.keys(HANDLERS),
      })
    )
    return
  }

  // Parse query params
  const params = Object.fromEntries(url.searchParams.entries())

  totalRequests++
  const reqStart = Date.now()

  log(`-> ${handlerName} ${JSON.stringify(params)} (queue: ${requestQueue.length}, active: ${activeRequests})`)

  try {
    await ensureBrowser()

    const result = await enqueue(handlerName, params)
    const elapsed = Date.now() - reqStart

    log(`<- ${handlerName} OK (${elapsed}ms)`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    totalErrors++
    const elapsed = Date.now() - reqStart
    const errMsg = err.message || String(err)

    log(`<- ${handlerName} ERROR (${elapsed}ms): ${errMsg}`)

    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: errMsg }))
  }
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  log(`${signal} received — shutting down...`)

  server.close()

  // Reject all queued requests
  while (requestQueue.length > 0) {
    const item = requestQueue.shift()
    if (item) item.reject(new Error('Server shutting down'))
  }

  // Close browser
  if (browser) {
    try {
      await browser.close()
    } catch {
      // Already closed
    }
  }

  log('Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Handle uncaught errors to prevent crashes
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`)
  console.error(err.stack)
  // Don't exit — try to keep serving
})

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`)
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
  log(`Scraper v${VERSION} listening on :${PORT} (pool: ${POOL_SIZE} contexts)`)
  // Pre-launch browser
  ensureBrowser().catch((err) => {
    log(`Browser pre-launch failed: ${err.message} (will retry on first request)`)
  })
})
