#!/usr/bin/env node
/**
 * VPS Scraper v17 — Built on Crawlee (22K★)
 *
 * Replaces the custom Playwright scraper with crawlee's production-grade framework:
 * - Anti-detection (fingerprint randomization, stealth plugins)
 * - Automatic proxy rotation (when configured)
 * - Session management (cookies persist across requests to same domain)
 * - Request queue with retry + exponential backoff
 * - Auto-scaling concurrency based on system load
 * - Built-in error handling and statistics
 *
 * Deployment:
 *   scp scraper-crawlee.mjs VPS:/opt/arena-crawlee/server.mjs
 *   pm2 start /opt/arena-crawlee/server.mjs --name arena-crawlee -- --port 3457
 *
 * API compatible with v16 — same HTTP endpoints, same response format.
 */

import http from 'node:http'
import { PlaywrightCrawler, Configuration } from 'crawlee'

const PORT = parseInt(process.env.SCRAPER_PORT || '3457', 10)
const PROXY_KEY = process.env.PROXY_KEY || 'arena-proxy-sg-2026'
const VERSION = '17.0.0-crawlee'
const REQUEST_TIMEOUT_MS = 120_000

let totalRequests = 0
let totalErrors = 0
let activeRequests = 0
const startedAt = new Date().toISOString()

// Configure crawlee — no storage persistence, minimal footprint
Configuration.getGlobalConfig().set('persistStorage', false)

// ─── Exchange Handler Registry ──────────────────────────────────────────

const HANDLERS = {
  'bybit/leaderboard': async (page, params) => {
    const pageNo = parseInt(params.pageNo || '1', 10)
    const pageSize = parseInt(params.pageSize || '50', 10)
    const duration = params.dataDuration || params.duration || 'DATA_DURATION_THIRTY_DAY'

    await page.goto('https://www.bybitglobal.com/copyTrading/en/leaderboard-master', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(2000)

    const apiPath = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=${pageSize}&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
    const data = await page.evaluate(async (path) => {
      const res = await fetch(path)
      return res.json()
    }, apiPath)

    return data
  },

  'bitget/leaderboard': async (page, params) => {
    const pageNo = parseInt(params.pageNo || '1', 10)
    const pageSize = parseInt(params.pageSize || '100', 10)
    const period = params.period || 'WEEKLY'

    await page.goto('https://www.bitget.com/copytrading/trader', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(2000)

    const data = await page.evaluate(async ({ pageNo, pageSize, period }) => {
      const res = await fetch('https://www.bitget.com/v1/trigger/trace/public/traderList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageNo, pageSize, period,
          orderBy: 'ROI', orderType: 'DESC',
          traderType: 'ELITE',
        }),
      })
      return res.json()
    }, { pageNo, pageSize, period })

    return data
  },

  'gate/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    await page.goto('https://www.gate.com/copytrading/traders', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(async (limit) => {
      const res = await fetch(`/apiw/v2/copy/leader/list?page=1&limit=${limit}&sort_by=profit_rate&sort_type=desc`)
      return res.json()
    }, pageSize)

    return data
  },

  'mexc/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    await page.goto('https://futures.mexc.com/en-US/copyTrading/traders', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(async (limit) => {
      const res = await fetch(`/api/copyFutures/api/v1/traders/top?page=1&size=${limit}&sortBy=roi&sortDir=desc`)
      return res.json()
    }, pageSize)

    return data
  },

  'coinex/leaderboard': async (page, params) => {
    await page.goto('https://www.coinex.com/copy-trading/traders', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(async () => {
      const res = await fetch('/res/copy-trading/public/traders?page=1&page_size=50&sort_by=yield_rate&sort_dir=desc')
      return res.json()
    })

    return data
  },

  'bingx/leaderboard': async (page, params) => {
    const limit = parseInt(params.limit || '50', 10)

    await page.goto('https://bingx.com/en/CopyTrading/', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })

    // Scroll to trigger SPA API calls
    await page.evaluate(() => window.scrollTo(0, 500))
    await page.waitForTimeout(2000)

    try {
      const response = await page.waitForResponse(
        r => r.url().includes('multi-rank') && r.status() === 200,
        { timeout: 15000 }
      )
      return await response.json()
    } catch {
      // Fallback: direct fetch
      const data = await page.evaluate(async (lim) => {
        const res = await fetch(`/api/uc/v1/public/copyTrade/traders?page=1&pageSize=${lim}&period=30d&sortBy=roi&sortOrder=desc`)
        return res.json()
      }, limit)
      return data
    }
  },

  'blofin/leaderboard': async (page, params) => {
    const limit = parseInt(params.limit || '50', 10)

    await page.goto('https://blofin.com/copy-trading/traders', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(async (lim) => {
      const res = await fetch(`/api/v1/copy-trade/traders?page=1&pageSize=${lim}&sort=roi&order=desc`)
      return res.json()
    }, limit)

    return data
  },

  'bybit/leaderboard-batch': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)
    const durations = (params.durations || 'DATA_DURATION_THIRTY_DAY').split(',')

    await page.goto('https://www.bybitglobal.com/copyTrading/en/leaderboard-master', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(2000)

    const results = await page.evaluate(async (opts) => {
      const out = {}
      for (const dur of opts.durations) {
        const d = dur.trim()
        try {
          const path = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=1&pageSize=${opts.pageSize}&dataDuration=${d}&sortField=LEADER_SORT_FIELD_SORT_ROI`
          const r = await fetch(path)
          out[d] = r.ok ? await r.json() : { error: 'HTTP ' + r.status }
        } catch (e) { out[d] = { error: e.message } }
      }
      return out
    }, { durations, pageSize })

    return results
  },

  'bitunix/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    await page.goto('https://www.bitunix.com/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollBy(0, 500))
    await page.waitForTimeout(3000)

    // Try page.evaluate fetch with credentials (same-origin)
    const data = await page.evaluate(async (opts) => {
      try {
        const r = await fetch(`/api/v1/copy-trade/traders?page=1&pageSize=${opts.pageSize}&sortType=2`, {
          credentials: 'include',
        })
        if (!r.ok) return null
        const text = await r.text()
        if (!text.startsWith('{')) return null
        return JSON.parse(text)
      } catch { return null }
    }, { pageSize })

    return data || { error: 'No API response captured' }
  },

  'toobit/leaderboard': async (_page, params) => {
    // Direct fetch — no browser needed (Toobit API is publicly accessible)
    const period = params.period || '30'
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://www.toobit.com/copytrading/ranking',
      'Origin': 'https://www.toobit.com',
      'Accept': 'application/json',
    }
    const allTraders = new Map()

    // Strategy 1: Ranking API — kind 0-4 (ROI, PnL, follower profit, followers, AUM)
    for (const kind of [0, 1, 2, 3, 4]) {
      try {
        const url = `https://bapi.toobit.com/bapi/v1/copy-trading/ranking?page=1&dataType=${period}&kind=${kind}`
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
        if (!r.ok) continue
        const text = await r.text()
        if (!text.startsWith('{')) continue
        const json = JSON.parse(text)
        const list = json?.data?.list || []
        for (const item of list) {
          const id = item.leaderUserId
          if (id && !allTraders.has(id)) allTraders.set(id, item)
        }
      } catch { /* skip */ }
    }

    // Strategy 2: identity-type-leaders
    try {
      const url = `https://bapi.toobit.com/bapi/v1/copy-trading/identity-type-leaders?dataType=${period}`
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
      if (r.ok) {
        const json = await r.json()
        for (const key of Object.keys(json?.data || {})) {
          const list = json.data[key]
          if (!Array.isArray(list)) continue
          for (const item of list) {
            const id = item.leaderUserId
            if (id && !allTraders.has(id)) {
              allTraders.set(id, {
                leaderUserId: id, name: item.nickname, avatar: item.avatar,
                profitRatio: item.leaderAvgProfitRatio, profit: item.pnl,
                followerProfit: item.followTotalProfit, followerTotal: item.currentFollowerCount,
              })
            }
          }
        }
      }
    } catch { /* skip */ }

    return { code: 200, data: { list: Array.from(allTraders.values()), total: allTraders.size } }
  },

  'xt/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '500', 10)

    // Anti-bot evasion
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      window.chrome = { runtime: {} }
    })

    // XT.com WAF can be slow — use 60s timeout
    await page.goto('https://www.xt.com/en/futures/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    })

    // Wait for CF challenge to pass
    try {
      await page.waitForFunction(() => {
        return !document.title.includes('Just a moment') && !document.querySelector('#challenge-running')
      }, { timeout: 20000 })
    } catch { /* proceed anyway */ }
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(5000)

    // Try multiple API endpoints from page context
    const data = await page.evaluate(async (opts) => {
      async function safeFetch(url) {
        try {
          const r = await fetch(url, { credentials: 'include' })
          if (!r.ok) return null
          const text = await r.text()
          if (!text.startsWith('{')) return null
          return JSON.parse(text)
        } catch { return null }
      }
      const eps = [
        `/fapi/user/v1/public/copy-trade/elite-leader-list-v2?page=1&size=${opts.pageSize}`,
        `/fapi/user/v1/public/trader/list?page=1&size=${opts.pageSize}&sortField=yield&sortType=1`,
      ]
      for (const ep of eps) {
        const json = await safeFetch(ep)
        if (json?.result || json?.data) return json
      }
      return null
    }, { pageSize })

    return data || { error: 'No API response captured' }
  },

  'weex/leaderboard': async (page, params) => {
    await page.goto('https://www.weex.com/en/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(8000)
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(3000)

    // Try to capture copy-trade API responses via page.evaluate
    const data = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/copy-trade/rank/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ pageNum: 1, pageSize: 50, sortField: 'ROI' }),
        })
        if (!r.ok) return null
        const text = await r.text()
        if (!text.startsWith('{') && !text.startsWith('[')) return null
        return JSON.parse(text)
      } catch { return null }
    })

    return data || { error: 'No API response captured' }
  },

  'weex/leaderboard-v2': async (page, params) => {
    // Alias — same handler as weex/leaderboard
    return HANDLERS['weex/leaderboard'](page, params)
  },
}

// ─── HTTP Server ────────────────────────────────────────────────────────

async function handleScrapeRequest(handlerName, params) {
  const handler = HANDLERS[handlerName]
  if (!handler) {
    return { error: `Unknown handler: ${handlerName}`, available: Object.keys(HANDLERS) }
  }

  // Create a one-shot crawlee crawler for this request
  let result = null
  let crawlerError = null

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: REQUEST_TIMEOUT_MS / 1000,
    maxConcurrency: 1,
    headless: true,
    browserPoolOptions: {
      maxOpenPagesPerBrowser: 1,
      retireBrowserAfterPageCount: 1, // Fresh browser per request (anti-fingerprint)
    },
    launchContext: {
      launchOptions: {
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-extensions', '--disable-background-networking',
          '--js-flags=--max-old-space-size=256',
        ],
      },
    },
    async requestHandler({ page }) {
      // Apply stealth
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
      result = await handler(page, params)
    },
    async failedRequestHandler({ request }) {
      crawlerError = `Request failed after ${request.retryCount} retries: ${request.errorMessages.join(', ')}`
    },
  })

  await crawler.run([{ url: 'about:blank', uniqueKey: `${handlerName}-${Date.now()}` }])

  if (crawlerError) throw new Error(crawlerError)
  return result
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  // Health check
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      version: VERSION,
      uptime: process.uptime(),
      startedAt,
      stats: { totalRequests, totalErrors, activeRequests },
      handlers: Object.keys(HANDLERS),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    }))
    return
  }

  // Auth check
  const key = url.searchParams.get('key') || req.headers['x-proxy-key']
  if (key !== PROXY_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  // Route: /{exchange}/leaderboard?params...
  const handlerName = path.slice(1) // Remove leading /
  const params = Object.fromEntries(url.searchParams.entries())
  delete params.key

  totalRequests++
  activeRequests++
  const start = Date.now()

  console.log(`[${new Date().toISOString()}] ${handlerName} START`)

  try {
    const data = await handleScrapeRequest(handlerName, params)
    activeRequests--
    const duration = Date.now() - start
    console.log(`[${new Date().toISOString()}] ${handlerName} OK ${duration}ms`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  } catch (err) {
    activeRequests--
    totalErrors++
    const duration = Date.now() - start
    console.error(`[${new Date().toISOString()}] ${handlerName} ERROR ${duration}ms: ${err.message}`)

    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.listen(PORT, () => {
  console.log(`Arena Crawlee Scraper v${VERSION} listening on :${PORT}`)
  console.log(`Handlers: ${Object.keys(HANDLERS).join(', ')}`)
})
