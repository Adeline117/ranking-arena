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
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT || '120000', 10)
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
  // No shared browser — each request launches its own (v15 pattern for WAF isolation)
  // Just ensure the concurrency slots are initialized
  if (contextPool.length === 0) {
    for (let i = 0; i < POOL_SIZE; i++) {
      contextPool.push({ context: null, busy: false, id: i })
    }
    log(`${POOL_SIZE} concurrency slots ready (fresh browser per request)`)
  }
}

/**
 * Acquire a free slot. Returns null if all busy.
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
  slot.context = null
  slot.busy = false
  // Process next queued request
  processQueue()
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

  // Launch FRESH browser per request (v15 pattern — full WAF/fingerprint isolation)
  const reqBrowser = await chromium.launch({ headless: true, args: BROWSER_ARGS })
  const context = await reqBrowser.newContext({
    userAgent: DEFAULT_UA,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  })
  slot.context = context

  // Per-request timeout
  const timeout = setTimeout(() => {
    reqBrowser.close().catch(() => {})
  }, REQUEST_TIMEOUT_MS)

  try {
    const handlerFn = HANDLERS[handler]
    if (!handlerFn) throw new Error(`Unknown handler: ${handler}`)

    const page = await context.newPage()
    try {
      const result = await handlerFn(page, params)
      return result
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    clearTimeout(timeout)
    await reqBrowser.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Exchange Handlers
// ---------------------------------------------------------------------------

/**
 * Setup API response interception on a page (v15 pattern).
 * Returns array of captured { url, data, size } objects.
 */
function setupInterception(page, matchFn) {
  const captured = []
  page.on('response', async (response) => {
    try {
      const url = response.url()
      if (url.match(/\.(js|css|png|jpg|svg|woff|ico|gif|webp)(\?|$)/)) return
      const ct = response.headers()['content-type'] || ''
      if (!ct.includes('json') || response.status() !== 200) return
      if (!matchFn(url)) return
      const text = await response.text()
      if (text.length > 100) {
        captured.push({ url, data: JSON.parse(text), size: text.length })
      }
    } catch { /* consumed or network error */ }
  })
  return captured
}

/**
 * Wait for Cloudflare challenge to complete.
 */
async function waitForCF(page, timeoutMs = 20000) {
  try {
    await page.waitForFunction(() => {
      return !document.title.includes('Just a moment') && !document.querySelector('#challenge-running')
    }, { timeout: timeoutMs })
  } catch { /* timeout — proceed anyway */ }
  await page.waitForTimeout(2000)
}

const HANDLERS = {
  // ─── Bybit (v15: relative path /x-api/, same-origin fetch) ──────
  'bybit/leaderboard': async (page, params) => {
    const pageNo = parseInt(params.pageNo || '1', 10)
    const pageSize = parseInt(params.pageSize || '50', 10)
    const duration = params.dataDuration || params.duration || 'DATA_DURATION_THIRTY_DAY'

    await page.goto('https://www.bybitglobal.com/copyTrading/en/leaderboard-master', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(2000)

    // Same-origin relative path — no CORS issues
    const apiPath = `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${pageNo}&pageSize=${pageSize}&dataDuration=${duration}&sortField=LEADER_SORT_FIELD_SORT_ROI`
    const data = await page.evaluate(async (path) => {
      try {
        const r = await fetch(path)
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }, apiPath).catch(() => null)

    if (data?.result?.leaderDetails?.length > 0) return data
    return data || { error: 'No API response captured' }
  },

  'bybit/trader-detail': async (page, params) => {
    const leaderMark = params.leaderMark || ''
    if (!leaderMark) return { error: 'leaderMark required' }

    // Navigate to a Bybit copy-trade page to get valid session cookies
    await page.goto('https://www.bybitglobal.com/copyTrading/en/leaderboard-master', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(2000)

    // Fetch trader detail via same-origin x-api (bypasses Akamai WAF)
    const data = await page.evaluate(async (mark) => {
      try {
        // Fetch leader details (includes PnL, AUM, follower stats)
        const detailPath = `/x-api/fapi/beehive/public/v1/common/leader-details?leaderMark=${encodeURIComponent(mark)}`
        const r = await fetch(detailPath)
        if (!r.ok) return { error: 'HTTP ' + r.status }
        const detail = await r.json()

        // Also fetch performance history (PnL curve)
        let pnlHistory = null
        try {
          const histPath = `/x-api/fapi/beehive/public/v1/common/leader-history-pnl?leaderMark=${encodeURIComponent(mark)}`
          const h = await fetch(histPath)
          if (h.ok) pnlHistory = await h.json()
        } catch {}

        return { detail, pnlHistory }
      } catch (e) { return { error: e.message } }
    }, leaderMark).catch(() => null)

    return data || { error: 'No API response captured' }
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
    }, { durations, pageSize }).catch(() => ({}))

    return results
  },

  // ─── Bitget (v15 port: POST with JSON body via page.evaluate) ───
  'bitget/leaderboard': async (page, params) => {
    const pageNo = parseInt(params.pageNo || '1', 10)
    const pageSize = parseInt(params.pageSize || '50', 10)
    const period = params.period || 'THIRTY_DAYS'

    const captured = setupInterception(page, (url) =>
      url.includes('trace') && (url.includes('traderList') || url.includes('trader'))
    )

    await page.goto('https://www.bitget.com/copy-trading/futures', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await waitForCF(page)

    // POST API from page context (inherits CF cookie)
    const data = await page.evaluate(async (opts) => {
      try {
        const r = await fetch('https://www.bitget.com/v1/trigger/trace/public/traderList', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'locale': 'en-US' },
          body: JSON.stringify({ pageNo: opts.pageNo, pageSize: opts.pageSize, sortType: 'ROI', period: opts.period }),
        })
        if (!r.ok) return { code: 'HTTP_' + r.status, data: null }
        const text = await r.text()
        if (!text.startsWith('{')) return { code: 'NOT_JSON', data: null }
        return JSON.parse(text)
      } catch (e) { return { code: 'FETCH_ERROR', data: null, error: e.message } }
    }, { pageNo, pageSize, period }).catch(() => null)

    if (data?.code === '00000' && (data?.data?.rows?.length > 0 || data?.data?.traderList?.length > 0)) {
      return data
    }

    await page.waitForTimeout(5000)
    if (captured.length > 0) return captured[0].data
    return { error: 'No API response captured' }
  },

  // ─── Gate.io (v15 port: page.evaluate with credentials) ─────────
  'gateio/leaderboard': async (page, params) => {
    const cycle = params.cycle || 'month'
    const pageNum = parseInt(params.page || '1', 10)

    const captured = setupInterception(page, (url) =>
      url.includes('apiw') && url.includes('copy') && url.includes('leader')
    )

    await page.goto('https://www.gate.com/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(async (opts) => {
      try {
        const r = await fetch(`https://www.gate.com/apiw/v2/copy/leader/list?page=${opts.pageNum}&page_size=50&order_by=profit_rate&cycle=${opts.cycle}`, {
          credentials: 'include',
        })
        if (!r.ok) return null
        const text = await r.text()
        if (!text.startsWith('{')) return null
        return JSON.parse(text)
      } catch { return null }
    }, { cycle, pageNum }).catch(() => null)

    if (data?.list?.length > 0 || data?.data?.list?.length > 0) return data

    await page.waitForTimeout(5000)
    if (captured.length > 0) return captured[0].data
    return { error: 'No API response captured' }
  },

  // ─── MEXC (v15: same-origin fetch with credentials) ──────────────
  'mexc/leaderboard': async (page, params) => {
    const periodType = parseInt(params.periodType || '2', 10)
    const pageSize = parseInt(params.pageSize || '50', 10)

    const captured = setupInterception(page, (url) =>
      url.includes('copyFutures') || url.includes('copy-trade') || url.includes('copyTrade')
    )

    await page.goto('https://www.mexc.com/futures/copyTrade/home', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await page.waitForTimeout(2000)

    // Same-origin relative paths — bypass WAF
    // Each fetch has a 10s AbortController timeout to prevent hanging
    const data = await page.evaluate(async (opts) => {
      const FETCH_TIMEOUT = 10000
      async function safeFetch(url, fetchOpts) {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT)
        try {
          const r = await fetch(url, { credentials: 'include', signal: ac.signal, ...fetchOpts })
          clearTimeout(timer)
          if (!r.ok) return null
          const text = await r.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return null
          return JSON.parse(text)
        } catch { clearTimeout(timer); return null }
      }
      const r1 = await safeFetch(`/api/platform/futures/copyFutures/api/v1/traders/top?limit=${opts.pageSize}`)
      if (r1?.data?.comprehensives?.length > 0) return r1
      const r2 = await safeFetch(`/api/platform/futures/copyFutures/api/v1/ai/recommend/traders?limit=${opts.pageSize}`)
      if (Array.isArray(r2?.data) && r2.data.length > 0) return r2
      const r3 = await safeFetch('/api/platform/copy-trade/rank/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageNum: 1, pageSize: opts.pageSize, periodType: opts.periodType, sortField: 'ROI' }),
      })
      if (r3?.data) return r3
      return null
    }, { periodType, pageSize }).catch(() => null)

    if (data) return data

    // Fallback to intercepted responses (no extra wait — interception ran during page load)
    if (captured.length > 0) {
      captured.sort((a, b) => b.size - a.size)
      return captured[0].data
    }
    return { error: 'All MEXC endpoints failed' }
  },

  // ─── CoinEx (v15 port: intercept + page.evaluate fallback) ──────
  'coinex/leaderboard': async (page, params) => {
    const period = params.period || '30d'
    const pageSize = parseInt(params.pageSize || '50', 10)

    const captured = setupInterception(page, (url) =>
      url.includes('copy-trading') || url.includes('copy-trade')
    )

    await page.goto('https://www.coinex.com/en/copy-trading/futures', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(8000)
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(3000)

    // Check intercepted responses first
    const traderResponses = captured.filter(c => {
      const d = c.data
      if (!d?.data) return false
      const items = d.data.data || d.data.items || d.data.list || (Array.isArray(d.data) ? d.data : [])
      return items.length > 0 && (items[0].trader_id || items[0].traderId || items[0].nickname)
    })
    if (traderResponses.length > 0) {
      traderResponses.sort((a, b) => b.size - a.size)
      return traderResponses[0].data
    }

    // Fallback: page.evaluate with credentials
    const data = await page.evaluate(async (opts) => {
      async function safeFetch(url) {
        try {
          const r = await fetch(url, { credentials: 'include' })
          if (!r.ok) return null
          const text = await r.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return null
          return JSON.parse(text)
        } catch { return null }
      }
      const trMap = { '7d': 'DAY7', '30d': 'DAY30', '90d': 'DAY90' }
      const tr = trMap[opts.period] || 'DAY30'
      const eps = [
        `/res/copy-trading/public/traders?data_type=profit_rate&time_range=${tr}&hide_full=0&page=1&limit=${opts.pageSize}`,
        `/res/copy-trade/rank?period=${opts.period}&page=1&limit=${opts.pageSize}&sort=roi`,
      ]
      for (const ep of eps) {
        const json = await safeFetch(ep)
        const items = json?.data?.data || json?.data?.items || (Array.isArray(json?.data) ? json.data : [])
        if (items.length > 0) return json
      }
      return { error: 'All CoinEx endpoints failed' }
    }, { period, pageSize }).catch(() => null)

    return data || { error: 'No API response captured' }
  },

  // ─── BingX (v15: scroll to trigger SPA, waitForResponse directly) ─
  'bingx/leaderboard': async (page, params) => {
    // Anti-bot evasion
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      window.chrome = { runtime: {} }
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    })

    await page.goto('https://bingx.com/en/CopyTrading/leaderBoard', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    })
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollTo(0, 300)).catch(() => {})

    // Wait for multi-rank response and read body directly (don't use setupInterception)
    try {
      const response = await page.waitForResponse(
        (r) => r.url().includes('multi-rank') && r.status() === 200,
        { timeout: 30000 }
      )
      const text = await response.text()
      if (text.length > 100) return JSON.parse(text)
    } catch { /* timeout */ }

    // Fallback: try same-origin fetch
    const data = await page.evaluate(async () => {
      try {
        const r = await fetch('/en/CopyTrading/api/multi-rank', { credentials: 'include' })
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }).catch(() => null)

    return data || { error: 'No API response captured' }
  },

  // ─── BloFin (page.evaluate with direct API) ─────────────────────
  'blofin/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    const captured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('trader') || url.includes('rank'))
    )

    await page.goto('https://www.blofin.com/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await page.waitForTimeout(3000)

    const data = await page.evaluate(async (opts) => {
      try {
        const r = await fetch(`https://openapi.blofin.com/api/v1/copy-trading/public/current-traders?pageSize=${opts.pageSize}&pageNo=1&sortBy=pnl&sortType=desc`)
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }, { pageSize }).catch(() => null)

    if (data?.data?.length > 0) return data

    await page.waitForTimeout(5000)
    if (captured.length > 0) return captured[0].data
    return { error: 'No API response captured' }
  },

  // ─── Bitunix (page.evaluate) ────────────────────────────────────
  'bitunix/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '50', 10)

    const captured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('trader') || url.includes('rank') || url.includes('leader'))
    )

    await page.goto('https://www.bitunix.com/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollBy(0, 500))
    await page.waitForTimeout(3000)

    if (captured.length === 0) {
      const data = await page.evaluate(async (opts) => {
        try {
          const r = await fetch(`/api/v1/copy-trade/traders?page=1&pageSize=${opts.pageSize}&sortType=2`, { credentials: 'include' })
          if (!r.ok) return null
          const text = await r.text()
          if (!text.startsWith('{')) return null
          return JSON.parse(text)
        } catch { return null }
      }, { pageSize }).catch(() => null)
      if (data) return data
    }

    if (captured.length > 0) return captured[0].data
    return { error: 'No API response captured' }
  },

  // ─── Toobit (v15: direct API to bapi.toobit.com, no browser!) ────
  'toobit/leaderboard': async (_page, params) => {
    const period = params.period || '30'
    const headers = {
      'User-Agent': DEFAULT_UA,
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
        log(`Toobit: kind=${kind} got ${list.length}, ${allTraders.size} total`)
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

    log(`Toobit: total unique traders: ${allTraders.size}`)
    return { code: 200, data: { list: Array.from(allTraders.values()), total: allTraders.size } }
  },

  // ─── XT (v15: intercept + page.evaluate, 60s timeout for WAF) ──
  'xt/leaderboard': async (page, params) => {
    const pageSize = parseInt(params.pageSize || '500', 10)

    // Anti-bot evasion
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      window.chrome = { runtime: {} }
    })

    const captured = setupInterception(page, (url) =>
      url.includes('fapi') && (url.includes('user') || url.includes('rank') || url.includes('leader') || url.includes('elite'))
    )

    // XT.com WAF can be slow — use 60s timeout
    await page.goto('https://www.xt.com/en/futures/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    })
    await waitForCF(page, 20000)
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(5000)

    if (captured.length > 0) {
      captured.sort((a, b) => b.size - a.size)
      return captured[0].data
    }

    // Fallback: try multiple API endpoints from page context
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
      // Try multiple known endpoints
      const eps = [
        `/fapi/user/v1/public/copy-trade/elite-leader-list-v2?page=1&size=${opts.pageSize}`,
        `/fapi/user/v1/public/trader/list?page=1&size=${opts.pageSize}&sortField=yield&sortType=1`,
      ]
      for (const ep of eps) {
        const json = await safeFetch(ep)
        if (json?.result || json?.data) return json
      }
      return null
    }, { pageSize }).catch(() => null)

    return data || { error: 'No API response captured' }
  },

  // ─── Weex (v15 port: intercept copy-trade APIs) ──────────────────
  'weex/leaderboard': async (page, params) => {
    const captured = setupInterception(page, (url) =>
      url.includes('copy') && (url.includes('rank') || url.includes('trader'))
    )

    await page.goto('https://www.weex.com/en/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    })
    await page.waitForTimeout(8000)
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(3000)

    if (captured.length > 0) {
      captured.sort((a, b) => b.size - a.size)
      return captured[0].data
    }
    return { error: 'No API response captured' }
  },

  'weex/leaderboard-v2': async (page, params) => {
    return HANDLERS['weex/leaderboard'](page, params)
  },

  // ─── Crypto.com (Cloudflare JS challenge, intercept copy-trade APIs) ───
  'crypto_com/leaderboard': async (page, params) => {
    const period = params.period || '30'

    // Anti-bot evasion
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      window.chrome = { runtime: {} }
    })

    // Intercept any copy-trade / leaderboard / trader API calls
    const captured = setupInterception(page, (url) =>
      url.includes('copy_trade') || url.includes('copy-trade') ||
      url.includes('leaderboard') || url.includes('lead_trader') ||
      url.includes('trader_list') || url.includes('traderList')
    )

    // Navigate to the copy trading page
    await page.goto('https://crypto.com/exchange/copy-trading', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    })

    // Wait for Cloudflare challenge to resolve
    await waitForCF(page, 25000)

    // Wait for SPA to load and fire API calls
    await page.waitForTimeout(5000)

    // Scroll to trigger lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(3000)

    // Check if we captured API responses via interception
    if (captured.length > 0) {
      // Sort by size — largest response likely has the most traders
      captured.sort((a, b) => b.size - a.size)
      return captured[0].data
    }

    // Fallback: try fetching from page context (inherits CF cookies)
    const data = await page.evaluate(async (opts) => {
      async function safeFetch(url, fetchOpts = {}) {
        try {
          const r = await fetch(url, { credentials: 'include', ...fetchOpts })
          if (!r.ok) return null
          const text = await r.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return null
          return JSON.parse(text)
        } catch { return null }
      }

      // Try known/likely API patterns
      const endpoints = [
        // GET endpoints
        { url: `/fe-ex-api/copy_trade/get_lead_trader_leaderboard?page=1&page_size=100&period=${opts.period}` },
        { url: `/fe-ex-api/copy_trade/get_lead_trader_list?page=1&page_size=100&sort_by=roi&period=${opts.period}` },
        { url: `/exchange/api/v1/copy-trading/leaders?page=1&size=100&period=${opts.period}` },
        { url: `/api/v1/copy-trade/leader/list?page=1&pageSize=100&period=${opts.period}` },
      ]

      for (const ep of endpoints) {
        const json = await safeFetch(ep.url)
        if (json) {
          // Check if response has meaningful data
          const hasData = json.data || json.result || json.list || json.traders || json.rows || Array.isArray(json)
          if (hasData) return json
        }
      }

      // Try POST endpoints
      const postEndpoints = [
        { url: '/fe-ex-api/copy_trade/get_lead_trader_leaderboard', body: { page: 1, page_size: 100, period: parseInt(opts.period) } },
        { url: '/fe-ex-api/copy_trade/get_lead_trader_list', body: { page: 1, page_size: 100, sort_by: 'roi', period: parseInt(opts.period) } },
      ]

      for (const ep of postEndpoints) {
        const json = await safeFetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ep.body),
        })
        if (json) {
          const hasData = json.data || json.result || json.list || json.traders || json.rows || Array.isArray(json)
          if (hasData) return json
        }
      }

      return null
    }, { period }).catch(() => null)

    if (data) return data

    // Last resort: try to extract trader data from the DOM
    const domData = await page.evaluate(() => {
      try {
        // Look for trader cards/rows in the page
        const cards = document.querySelectorAll('[class*="trader"], [class*="leader"], [class*="copy"]')
        if (cards.length === 0) return null

        const traders = []
        cards.forEach((card) => {
          const name = card.querySelector('[class*="name"]')?.textContent?.trim()
          const roi = card.querySelector('[class*="roi"], [class*="profit"], [class*="return"]')?.textContent?.trim()
          if (name && roi) {
            traders.push({ display_name: name, roi_text: roi })
          }
        })
        return traders.length > 0 ? { traders, source: 'dom_extraction' } : null
      } catch { return null }
    }).catch(() => null)

    return domData || { error: 'No API response captured and DOM extraction failed' }
  },

  // ─── KuCoin (CF-protected SPA, intercept copy-trade APIs) ───
  'kucoin/leaderboard': async (page, params) => {
    const pageNo = parseInt(params.pageNo || '1', 10)
    const pageSize = parseInt(params.pageSize || '50', 10)

    // Anti-bot evasion
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      window.chrome = { runtime: {} }
    })

    // Intercept copy-trade API responses
    const captured = setupInterception(page, (url) =>
      url.includes('copy-trade') || url.includes('copyTrade') ||
      url.includes('leader') || url.includes('trader') ||
      url.includes('public/list')
    )

    await page.goto('https://www.kucoin.com/copytrading', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    })

    await waitForCF(page, 25000)
    await page.waitForTimeout(5000)
    await page.evaluate(() => window.scrollTo(0, 500)).catch(() => {})
    await page.waitForTimeout(3000)

    if (captured.length > 0) {
      captured.sort((a, b) => b.size - a.size)
      return captured[0].data
    }

    // Fallback: same-origin fetch with session cookies
    const data = await page.evaluate(async (opts) => {
      async function safeFetch(url) {
        try {
          const r = await fetch(url, { credentials: 'include' })
          if (!r.ok) return null
          const text = await r.text()
          if (!text.startsWith('{') && !text.startsWith('[')) return null
          return JSON.parse(text)
        } catch { return null }
      }

      const endpoints = [
        `/_api/copy-trade/leader/public/list?pageNo=${opts.pageNo}&pageSize=${opts.pageSize}&sortType=2`,
        `/api/v1/copy-trade/leader/public/list?pageNo=${opts.pageNo}&pageSize=${opts.pageSize}`,
        `/_api/copy-trade/leader/list?page=${opts.pageNo}&size=${opts.pageSize}`,
      ]

      for (const url of endpoints) {
        const json = await safeFetch(url)
        if (json) {
          const hasData = json.data || json.result || json.list || json.items || Array.isArray(json)
          if (hasData) return json
        }
      }
      return null
    }, { pageNo, pageSize }).catch(() => null)

    return data || { error: 'No API response captured' }
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
    const busySlots = contextPool.filter((s) => s.busy).length
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
          busy: busySlots,
          free: contextPool.length - busySlots,
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
        browserMode: 'fresh-per-request',
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

  // No shared browser to close (fresh per request)
  if (false) {
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
