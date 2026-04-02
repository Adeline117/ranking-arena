#!/usr/bin/env node
/**
 * VPS-local cron: fetch traders via Playwright scraper and write to Supabase.
 * Runs on the same VPS as the scraper, so no network hop — much faster than
 * Vercel crons going through HTTP proxy chain.
 *
 * Calls scraper at localhost:3457, writes to Supabase via REST API.
 *
 * Usage: node scraper-cron.mjs [platform1,platform2,...]
 * Default: all scraper platforms (bingx, bingx_spot)
 *
 * Crontab: 0 0,3,6,9,12,15,18,21 * * * node /opt/arena-cron/scraper-cron.mjs
 */

const SCRAPER_URL = 'http://localhost:3457'
const SCRAPER_KEY = 'arena-proxy-sg-2026'
const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── Startup guard: refuse to run without Supabase key ──
if (!SUPABASE_KEY || SUPABASE_KEY === 'PASTE_SERVICE_ROLE_KEY_HERE') {
  console.error('[FATAL] SUPABASE_SERVICE_ROLE_KEY is not set. Refusing to run.')
  console.error('Fix: set it in ecosystem.config.js env block, then `pm2 restart arena-cron && pm2 save`')
  sendTelegramSync('🚨 <b>VPS scraper-cron BLOCKED</b>\nSUPABASE_SERVICE_ROLE_KEY is not set.\nData is NOT being written to Supabase.')
  process.exit(1)
}

// ── Telegram alert helpers ──
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram disabled]', text)
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
  } catch (err) {
    console.error('Telegram send failed:', err.message)
  }
}

// Sync version for startup guard (before event loop)
function sendTelegramSync(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    // Use sync XMLHttpRequest-like approach — but in Node we just fire-and-forget
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    }).catch(() => {})
  } catch (_) {}
}

// ============================================
// Platform configs: scraper endpoint + periods
// ============================================

const PLATFORMS = {
  bingx: {
    source: 'bingx',
    market_type: 'futures',
    endpoint: '/bingx/leaderboard',
    periods: {
      '2': '30D',
    },
    pageSize: 50,
    extractList: (data) => {
      if (data?.data?.global?.result) return data.data.global.result
      if (data?.data?.result) return data.data.result
      if (Array.isArray(data?.data)) return data.data
      return []
    },
    normalize: (raw) => {
      // BingX multi-rank nests trader data under traderInfoVo
      const info = raw.traderInfoVo || {}
      const rawRoi = num(raw.cumulativePnlRate7Days ?? raw.roi ?? raw.roiRate ?? raw.returnRate)
      const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
      const rawWr = num(raw.winRate)
      const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
      const rawMdd = num(raw.maxDrawdown)
      const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null
      return {
        trader_key: String(info.trader || info.apiIdentity || raw.uniqueId || raw.uid || ''),
        display_name: info.traderName || raw.traderName || raw.nickname || null,
        roi,
        pnl: num(raw.totalEarnings ?? raw.pnl ?? raw.totalPnl ?? raw.profit),
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        sharpe_ratio: null,
        followers: num(raw.followerNum ?? raw.followers ?? raw.followerCount),
      }
    },
  },

  bingx_spot: {
    source: 'bingx_spot',
    market_type: 'spot',
    endpoint: '/bingx/leaderboard',
    periods: {
      '2': '30D',
    },
    pageSize: 50,
    // BingX spot needs type=spot param
    extraParams: { type: 'spot' },
    extractList: (data) => {
      if (data?.data?.global?.result) return data.data.global.result
      if (data?.data?.result) return data.data.result
      if (Array.isArray(data?.data)) return data.data
      return []
    },
    normalize: (raw) => {
      const info = raw.traderInfoVo || {}
      const rawRoi = num(raw.cumulativePnlRate7Days ?? raw.roi ?? raw.roiRate ?? raw.returnRate)
      const roi = rawRoi != null ? (Math.abs(rawRoi) <= 1 ? rawRoi * 100 : rawRoi) : null
      const rawWr = num(raw.winRate)
      const winRate = rawWr != null ? (rawWr <= 1 ? rawWr * 100 : rawWr) : null
      return {
        trader_key: String(info.trader || info.apiIdentity || raw.uniqueId || raw.uid || ''),
        display_name: info.traderName || raw.traderName || raw.nickname || null,
        roi,
        pnl: num(raw.totalEarnings ?? raw.pnl ?? raw.totalPnl ?? raw.profit),
        win_rate: winRate,
        max_drawdown: null,
        sharpe_ratio: null,
        followers: num(raw.followerNum ?? raw.followers ?? raw.followerCount),
      }
    },
  },

}

// ============================================
// Rate Limiting: Token Bucket (30 req/min global)
// ============================================

class TokenBucket {
  constructor(maxTokens, refillRate) {
    this.maxTokens = maxTokens
    this.tokens = maxTokens
    this.refillRate = refillRate // tokens per ms
    this.lastRefill = Date.now()
  }

  _refill() {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate)
    this.lastRefill = now
  }

  async acquire() {
    this._refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    // Wait until a token is available
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate)
    await new Promise(r => setTimeout(r, waitMs))
    this._refill()
    this.tokens -= 1
  }
}

// 30 requests per minute = 0.5 tokens/second = 0.0005 tokens/ms
const globalBucket = new TokenBucket(30, 30 / 60000)

// ============================================
// Per-platform sequential lock (concurrency = 1)
// ============================================

const platformLocks = new Map()

function withPlatformLock(platformKey, fn) {
  const prev = platformLocks.get(platformKey) || Promise.resolve()
  const next = prev.then(fn, fn) // run fn after previous completes (even if it failed)
  platformLocks.set(platformKey, next)
  return next
}

// ============================================
// Helpers
// ============================================

function num(val) {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

function ts() {
  return new Date().toISOString()
}

function log(msg) {
  console.log('[' + ts() + '] ' + msg)
}

// ============================================
// Scraper client
// ============================================

async function callScraper(endpoint, params = {}, timeoutMs = 180000) {
  const url = new URL(endpoint, SCRAPER_URL)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await globalBucket.acquire()
    const res = await fetch(url.toString(), {
      headers: { 'x-proxy-key': SCRAPER_KEY },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      throw new Error('Scraper returned ' + res.status + ': ' + (await res.text().catch(() => '')))
    }
    return await res.json()
  } catch (err) {
    clearTimeout(timeout)
    throw err
  }
}

// ============================================
// Supabase REST API client
// ============================================

async function supabaseUpsert(table, rows, onConflict) {
  if (!rows.length) return { count: 0 }

  const CHUNK = 200
  let total = 0

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)

    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error('Supabase ' + table + ' upsert error (' + res.status + '): ' + errText)
    }
    total += chunk.length
  }

  return { count: total }
}

// ============================================
// Build snapshot rows from normalized data
// ============================================

function buildSnapshotRows(normalized, platform, marketType, window) {
  const now = new Date().toISOString()

  return normalized
    .filter(t => t.trader_key)
    .map(t => {
      const roiCapped = t.roi != null && Math.abs(t.roi) > 100000 ? null : (t.roi ?? null)

      return {
        platform,
        market_type: marketType,
        trader_key: t.trader_key,
        window: window,
        as_of_ts: now,
        updated_at: now,
        roi_pct: roiCapped,
        pnl_usd: t.pnl ?? null,
        win_rate: t.win_rate ?? null,
        max_drawdown: t.max_drawdown ?? null,
        arena_score: t.roi != null ? 0 : null,
        sharpe_ratio: t.sharpe_ratio ?? null,
        trades_count: null,
        followers: t.followers ?? null,
        copiers: null,
        metrics: {
          roi: t.roi ?? null,
          pnl: t.pnl ?? null,
          win_rate: t.win_rate ?? null,
          max_drawdown: t.max_drawdown ?? null,
          trades_count: null,
          followers: t.followers ?? null,
          copiers: null,
          sharpe_ratio: t.sharpe_ratio ?? null,
          arena_score: null,
          aum: null,
        },
      }
    })
}

// ============================================
// Fetch one platform
// ============================================

async function fetchPlatform(platformKey) {
  const config = PLATFORMS[platformKey]
  if (!config) {
    log('Unknown platform: ' + platformKey)
    return { platform: platformKey, error: 'unknown platform' }
  }

  log('--- ' + platformKey + ' ---')
  let totalTraders = 0
  const results = {}

  // Call scraper once per period
  for (const [periodKey, window] of Object.entries(config.periods)) {
    log('  Fetching ' + window + ' (param=' + periodKey + ')...')

    try {
      let data
      // Direct API bypass: use mobile UA instead of VPS scraper (faster, no CF WAF issues)
      if (config.directApi) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 30000)
        try {
          // Substitute {period} placeholder with actual period key (e.g., 90d for CoinEx)
          const apiUrl = config.directApi.replace('{period}', periodKey)
          await globalBucket.acquire()
          const fetchOpts = {
            method: config.directMethod || 'GET',
            headers: config.directHeaders || {},
            signal: controller.signal,
          }
          if (config.directBody) {
            fetchOpts.body = JSON.stringify(config.directBody)
          }
          const res = await fetch(apiUrl, fetchOpts)
          clearTimeout(timeout)
          if (res.ok) {
            data = await res.json()
            log('  Direct API success (status ' + res.status + ')')
          } else {
            log('  Direct API failed (status ' + res.status + '), falling back to scraper')
            data = null
          }
        } catch (directErr) {
          clearTimeout(timeout)
          log('  Direct API error: ' + directErr.message + ', falling back to scraper')
          data = null
        }
      }

      // Fallback: VPS Playwright scraper
      if (!data) {
        const params = { pageSize: config.pageSize, ...(config.extraParams || {}) }
        if (platformKey === 'bingx' || platformKey === 'bingx_spot') {
          params.timeType = periodKey
        }
        data = await callScraper(config.endpoint, params, 120000)
      }
      const rawList = config.extractList(data)

      if (!rawList.length) {
        log('  ' + window + ': 0 traders (empty)')
        results[window] = { count: 0 }
        continue
      }

      const normalized = rawList.map(config.normalize)
      const v2Rows = buildSnapshotRows(normalized, config.source, config.market_type, window)

      const v2Result = await supabaseUpsert('trader_snapshots_v2', v2Rows, 'platform,market_type,trader_key,window,as_of_ts').catch(e => ({ error: e.message }))

      log('  ' + window + ': ' + normalized.length + ' traders -> v2: ' + (v2Result.count ?? v2Result.error))
      results[window] = { count: normalized.length }
      totalTraders += normalized.length
    } catch (err) {
      log('  ' + window + ': ERROR - ' + err.message)
      results[window] = { error: err.message }
    }

    // Small delay between periods to avoid overwhelming the scraper queue
    if (Object.keys(config.periods).length > 1) {
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  return { platform: platformKey, totalTraders, results }
}

// ============================================
// Main
// ============================================

async function main() {
  const startTime = Date.now()
  const args = process.argv[2]
  const requestedPlatforms = args
    ? args.split(',').map(p => p.trim())
    : Object.keys(PLATFORMS)

  log('=== VPS Scraper Cron Start ===')
  log('Platforms: ' + requestedPlatforms.join(', '))

  // Verify scraper is up
  try {
    const health = await fetch(SCRAPER_URL + '/health')
    const h = await health.json()
    log('Scraper: v' + (h.version || '?') + ', busy=' + h.busy + ', queued=' + h.queued)
  } catch (err) {
    log('ERROR: Scraper not reachable at ' + SCRAPER_URL + ': ' + err.message)
    process.exit(1)
  }

  // Process platforms sequentially with per-platform lock + global rate limit
  const allResults = []
  for (const p of requestedPlatforms) {
    try {
      const result = await withPlatformLock(p, () => fetchPlatform(p))
      allResults.push(result)
    } catch (err) {
      log('FATAL ERROR on ' + p + ': ' + err.message)
      allResults.push({ platform: p, error: err.message })
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const totalTraders = allResults.reduce((sum, r) => sum + (r.totalTraders || 0), 0)

  log('=== VPS Scraper Cron Done ===')
  log('Total: ' + totalTraders + ' traders across ' + requestedPlatforms.length + ' platforms in ' + elapsed + 's')

  const failures = []
  for (const r of allResults) {
    if (r.error) {
      log('  ' + r.platform + ': FAILED - ' + r.error)
      failures.push(r.platform + ': ' + r.error)
    } else {
      log('  ' + r.platform + ': ' + r.totalTraders + ' traders')
    }
  }

  // ── Telegram: alert on failures, summary on success ──
  if (failures.length > 0) {
    await sendTelegram(
      `🚨 <b>VPS Cron ${failures.length}/${requestedPlatforms.length} FAILED</b>\n` +
      failures.map(f => `• ${f}`).join('\n') +
      `\n\n✅ OK: ${totalTraders} traders in ${elapsed}s`
    )
  } else if (totalTraders === 0) {
    await sendTelegram(
      `⚠️ <b>VPS Cron: 0 traders written</b>\n` +
      `${requestedPlatforms.length} platforms ran but produced no data.\n⏱ ${elapsed}s`
    )
  }
  // Success with data: silent (no spam). Use daily report for normal monitoring.
}

main().catch(async err => {
  log('UNHANDLED ERROR: ' + err.message)
  console.error(err)
  await sendTelegram(`🔥 <b>VPS Cron CRASHED</b>\n<code>${err.message}</code>`)
  process.exit(1)
})
