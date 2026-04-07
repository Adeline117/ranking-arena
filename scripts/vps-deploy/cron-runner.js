#!/usr/bin/env node
/**
 * VPS Cron Runner — scrapes exchange data and pushes to Vercel ingest endpoint.
 *
 * Replaces Vercel cron for scraper-dependent platforms (bybit, bitget, mexc, etc.)
 * NO 300s timeout limit. Runs as PM2 process on VPS.
 *
 * Architecture:
 *   cron-runner → VPS scraper (localhost:3457) → normalize → POST /api/pipeline/ingest
 *
 * Schedule: node-cron, configurable per platform.
 * PM2: pm2 start cron-runner.js --name arena-cron-v2
 */

const cron = require('node-cron')
const http = require('http')

// ─── Config ───
const SCRAPER_URL = process.env.SCRAPER_URL || 'http://localhost:3457'
const SCRAPER_KEY = process.env.PROXY_KEY || 'arena-proxy-sg-2026'
const INGEST_URL = process.env.INGEST_URL || 'https://www.arenafi.org/api/pipeline/ingest'
const INGEST_KEY = process.env.VPS_PROXY_KEY || process.env.CRON_SECRET || SCRAPER_KEY

// Platforms that need VPS scraper (geo-blocked or WAF-protected)
const PLATFORMS = [
  {
    name: 'bybit',
    handler: 'bybit/leaderboard-batch',
    params: { durations: 'DATA_DURATION_SEVEN_DAY,DATA_DURATION_THIRTY_DAY,DATA_DURATION_NINETY_DAY', pageSize: '50' },
    schedule: '10 */2 * * *', // Every 2h
    normalize: normalizeBybitBatch,
  },
  {
    name: 'bybit_spot',
    handler: 'bybit/leaderboard',
    params: { pageNo: '1', pageSize: '50', dataDuration: 'DATA_DURATION_THIRTY_DAY' },
    schedule: '25 */3 * * *', // Every 3h
    normalize: normalizeBybitSingle,
    window: '30D',
  },
  {
    name: 'bitget_futures',
    handler: 'bitget/leaderboard',
    params: { pageNo: '1', pageSize: '50', period: 'THIRTY_DAYS' },
    schedule: '15 */3 * * *', // Every 3h
    normalize: normalizeBitget,
    window: '30D',
  },
  {
    name: 'mexc',
    handler: 'mexc/leaderboard',
    params: { periodType: '2', pageSize: '50' },
    schedule: '20 */4 * * *', // Every 4h
    normalize: normalizeMexc,
    window: '30D',
  },
]

// ─── Helpers ───
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function fetchJson(url, opts = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 60000)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    clearTimeout(timeout)
    throw e
  }
}

// ─── Normalizers ───
function normalizeBybitBatch(data) {
  // data = { DATA_DURATION_SEVEN_DAY: {...}, DATA_DURATION_THIRTY_DAY: {...}, ... }
  const windowMap = {
    'DATA_DURATION_SEVEN_DAY': '7D',
    'DATA_DURATION_THIRTY_DAY': '30D',
    'DATA_DURATION_NINETY_DAY': '90D',
  }
  const results = []
  for (const [durKey, resp] of Object.entries(data)) {
    const window = windowMap[durKey]
    if (!window || !resp?.result?.leaderDetails) continue
    const traders = resp.result.leaderDetails.map(t => ({
      trader_key: t.leaderMark || t.leaderId || '',
      display_name: t.nickName || t.nickname || null,
      roi_pct: t.roi != null ? Number(t.roi) : null,
      pnl_usd: t.pnl != null ? Number(t.pnl) : null,
      win_rate: t.winRate != null ? Number(t.winRate) : null,
      max_drawdown: t.maxDrawdown != null ? Number(t.maxDrawdown) : null,
      followers: t.followerCount != null ? Number(t.followerCount) : null,
      avatar_url: t.avatar || null,
    }))
    results.push({ window, traders })
  }
  return results
}

function normalizeBybitSingle(data) {
  if (!data?.result?.leaderDetails) return []
  return data.result.leaderDetails.map(t => ({
    trader_key: t.leaderMark || t.leaderId || '',
    display_name: t.nickName || t.nickname || null,
    roi_pct: t.roi != null ? Number(t.roi) : null,
    pnl_usd: t.pnl != null ? Number(t.pnl) : null,
    win_rate: t.winRate != null ? Number(t.winRate) : null,
    followers: t.followerCount != null ? Number(t.followerCount) : null,
    avatar_url: t.avatar || null,
  }))
}

function normalizeBitget(data) {
  const rows = data?.data?.rows || data?.data?.traderList || []
  return rows.map(t => ({
    trader_key: t.traderUid || t.traderId || '',
    display_name: t.nickName || t.traderName || null,
    roi_pct: t.roi != null ? Number(t.roi) : (t.yieldRate != null ? Number(t.yieldRate) : null),
    pnl_usd: t.profitAmount != null ? Number(t.profitAmount) : null,
    win_rate: t.winRate != null ? Number(t.winRate) : null,
    followers: t.followerCount != null ? Number(t.followerCount) : null,
    avatar_url: t.traderPic || null,
  }))
}

function normalizeMexc(data) {
  const items = data?.data?.comprehensives || data?.data || []
  if (!Array.isArray(items)) return []
  return items.map(t => ({
    trader_key: t.uid || t.traderId || '',
    display_name: t.nickName || t.nickname || null,
    roi_pct: t.roi != null ? Number(t.roi) : null,
    pnl_usd: t.profitAmount != null ? Number(t.profitAmount) : null,
    win_rate: t.winRate != null ? Number(t.winRate) : null,
    followers: t.followerCount != null ? Number(t.followerCount) : null,
  }))
}

// ─── Core: scrape + push ───
async function runPlatform(platform) {
  const start = Date.now()
  log(`[${platform.name}] Starting...`)

  try {
    // 1. Call VPS scraper
    const params = new URLSearchParams(platform.params).toString()
    const scraperUrl = `${SCRAPER_URL}/${platform.handler}?${params}`
    const rawData = await fetchJson(scraperUrl, {
      headers: { 'X-Proxy-Key': SCRAPER_KEY },
      timeout: 120000,
    })

    if (rawData.error) {
      log(`[${platform.name}] Scraper error: ${rawData.error}`)
      return
    }

    // 2. Normalize
    const normalized = platform.normalize(rawData)

    // 3. Push to ingest endpoint
    // Batch format: either [{window, traders}] or just traders (single window)
    const batches = Array.isArray(normalized) && normalized[0]?.window
      ? normalized // Multi-window batch
      : [{ window: platform.window || '30D', traders: normalized }]

    for (const batch of batches) {
      if (!batch.traders || batch.traders.length === 0) continue

      const resp = await fetchJson(INGEST_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Key': INGEST_KEY,
        },
        body: JSON.stringify({
          platform: platform.name,
          window: batch.window,
          traders: batch.traders,
        }),
        timeout: 30000,
      })

      log(`[${platform.name}/${batch.window}] Ingested: ${resp.upserted}/${batch.traders.length} (rejected: ${resp.rejected || 0}) in ${resp.elapsed_ms}ms`)
    }

    log(`[${platform.name}] Done in ${Date.now() - start}ms`)
  } catch (e) {
    log(`[${platform.name}] ERROR: ${e.message}`)
  }
}

// ─── Schedule ───
log('=== VPS Cron Runner v1.0 ===')
log(`Scraper: ${SCRAPER_URL}`)
log(`Ingest: ${INGEST_URL}`)
log(`Platforms: ${PLATFORMS.map(p => p.name).join(', ')}`)

for (const platform of PLATFORMS) {
  cron.schedule(platform.schedule, () => runPlatform(platform))
  log(`Scheduled ${platform.name}: ${platform.schedule}`)
}

// Run all immediately on startup (warm up)
log('Running initial fetch for all platforms...')
Promise.allSettled(PLATFORMS.map(p => runPlatform(p)))
  .then(results => {
    const ok = results.filter(r => r.status === 'fulfilled').length
    log(`Initial fetch: ${ok}/${PLATFORMS.length} succeeded`)
  })

// Health endpoint
const HEALTH_PORT = parseInt(process.env.CRON_HEALTH_PORT || '3458', 10)
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      uptime: process.uptime(),
      platforms: PLATFORMS.map(p => ({ name: p.name, schedule: p.schedule })),
      memory: { rss: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    }))
  } else {
    res.writeHead(404)
    res.end()
  }
}).listen(HEALTH_PORT, () => log(`Health endpoint on :${HEALTH_PORT}`))
