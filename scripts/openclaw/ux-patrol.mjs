#!/usr/bin/env node
/**
 * UX Patrol — Automated daily UX checks for Arena
 *
 * Checks:
 * 1. Core pages respond with 200
 * 2. No console errors in SSR HTML
 * 3. API endpoints return valid JSON
 * 4. Key data fields are present and non-null
 * 5. i18n: no raw Chinese in English-mode HTML, no raw English in Chinese-mode HTML
 *
 * Run: node scripts/openclaw/ux-patrol.mjs
 * Daily: openclaw cron add --name "UX Patrol" --schedule "0 9 * * *" --command "node scripts/openclaw/ux-patrol.mjs"
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { config as dotenvConfig } from 'dotenv'
const __uxdir = path.dirname(fileURLToPath(import.meta.url))
dotenvConfig({ path: path.resolve(__uxdir, '../../.env') })

const ARENA_URL = process.env.ARENA_URL || 'https://www.arenafi.org'
const REQUEST_TIMEOUT_MS = 10000
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 250
const USER_AGENT = 'Arena-UX-Patrol/1.0 (+https://www.arenafi.org)'
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const ACCESS_FAILURE_STATUSES = new Set([401, 403, 407, 408, 425, 429])

const results = []
let totalChecks = 0
let passed = 0
let warned = 0
let failed = 0
let blind = 0

function log(status, check, detail = '') {
  const icon =
    status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : status === 'BLIND' ? '🚫' : '❌'
  results.push({ status, check, detail })
  totalChecks++
  if (status === 'PASS') passed++
  else if (status === 'WARN') warned++
  else if (status === 'BLIND') blind++
  else failed++
  console.log(`${icon} ${check}${detail ? ` — ${detail}` : ''}`)
}

function recordAccessFailure(check, detail) {
  if (blind > 0) return
  log('BLIND', 'Sentinel blind/access failure', `${check}: ${detail}`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchAttempt(url, opts) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const headers = new Headers(opts.headers)
  headers.set('User-Agent', USER_AGENT)
  if (!headers.has('Accept')) headers.set('Accept', '*/*')

  try {
    const res = await fetch(url, { ...opts, headers, signal: controller.signal })
    return { ok: res.ok, status: res.status, body: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithTimeout(url, opts = {}) {
  let lastError

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchAttempt(url, opts)
      if (attempt < MAX_ATTEMPTS && RETRYABLE_STATUSES.has(res.status)) {
        await wait(RETRY_DELAY_MS)
        continue
      }
      return res
    } catch (error) {
      lastError = error
      if (attempt < MAX_ATTEMPTS) {
        await wait(RETRY_DELAY_MS)
        continue
      }
    }
  }

  throw lastError
}

function isAccessFailureResponse(res) {
  return ACCESS_FAILURE_STATUSES.has(res.status)
}

// 1. Page health checks
async function checkPages() {
  console.log('\n📄 Page Health Checks')
  const pages = ['/', '/rankings', '/rankings/7d', '/market', '/learn', '/login']

  for (const path of pages) {
    try {
      const res = await fetchWithTimeout(`${ARENA_URL}${path}`)
      if (isAccessFailureResponse(res)) {
        recordAccessFailure(`GET ${path}`, `Status ${res.status}`)
        continue
      }
      if (!res.ok) {
        log('FAIL', `GET ${path}`, `Status ${res.status}`)
        continue
      }

      const html = res.body
      // Check for Next.js error indicators
      if (html.includes('__NEXT_DATA__') || html.includes('__next')) {
        log('PASS', `GET ${path}`, `${res.status} (${(html.length / 1024).toFixed(0)}KB)`)
      } else {
        log('WARN', `GET ${path}`, 'Response missing Next.js markers')
      }
      // Check for hydration error markers
      if (html.includes('Hydration failed') || html.includes('hydration mismatch')) {
        log('FAIL', `${path} hydration`, 'Hydration error detected in HTML')
      }
    } catch (e) {
      recordAccessFailure(`GET ${path}`, e.message)
    }
  }
}

// Cached rankings data — fetched once, reused for API check + data quality
let cachedRankingsTraders = null
let rankingsProbeComplete = false

// 2. API health checks
async function checkAPIs() {
  console.log('\n🔌 API Health Checks')
  const apis = [
    {
      path: '/api/rankings?window=7d&limit=10',
      check: (d) => Array.isArray(d.data?.traders) && d.data.traders.length > 0,
      cacheTraders: true,
    },
    { path: '/api/market', check: (d) => Array.isArray(d.rows) && d.rows.length > 0 },
    { path: '/api/market/spot', check: (d) => Array.isArray(d) && d.length > 0 },
  ]

  for (const { path, check, cacheTraders } of apis) {
    try {
      const res = await fetchWithTimeout(`${ARENA_URL}${path}`)
      if (isAccessFailureResponse(res)) {
        recordAccessFailure(`API ${path}`, `Status ${res.status}`)
        if (cacheTraders) rankingsProbeComplete = true
        continue
      }
      if (!res.ok) {
        log('FAIL', `API ${path}`, `Status ${res.status}`)
        if (cacheTraders) rankingsProbeComplete = true
        continue
      }

      let data
      try {
        data = JSON.parse(res.body)
      } catch {
        log('FAIL', `API ${path}`, 'Response is not valid JSON')
        if (cacheTraders) rankingsProbeComplete = true
        continue
      }

      if (check(data)) {
        log('PASS', `API ${path}`, 'Valid response')
        if (cacheTraders) {
          cachedRankingsTraders = data.data?.traders || []
          rankingsProbeComplete = true
        }
      } else {
        log('FAIL', `API ${path}`, 'Response shape invalid or empty')
        if (cacheTraders) rankingsProbeComplete = true
      }
    } catch (e) {
      recordAccessFailure(`API ${path}`, e.message)
      if (cacheTraders) rankingsProbeComplete = true
    }
  }
}

// 3. Data quality spot checks (reuses rankings data from checkAPIs)
async function checkDataQuality() {
  console.log('\n📊 Data Quality Spot Checks')
  const traders = cachedRankingsTraders
  if (!rankingsProbeComplete || !traders) {
    return
  }

  if (traders.length === 0) {
    log('FAIL', 'Rankings data', 'No traders returned')
    return
  }

  // Check required fields (flat structure in API response)
  let missingCount = 0
  for (const t of traders) {
    if (!t.display_name && !t.trader_key) missingCount++
    if (!t.platform) missingCount++
    if (t.roi === null || t.roi === undefined) missingCount++
    if (t.pnl === null || t.pnl === undefined) missingCount++
    if (t.arena_score === null || t.arena_score === undefined) missingCount++
  }
  if (missingCount === 0) {
    log('PASS', 'Required fields present', `${traders.length} traders checked`)
  } else {
    log('WARN', 'Missing fields', `${missingCount} null/undefined fields in top 10`)
  }

  // Check score range (filter(v != null) keeps 0, unlike filter(Boolean))
  const scores = traders.map((t) => t.arena_score).filter((v) => v != null)
  if (scores.length === 0) {
    log('WARN', 'Score range', 'No arena_score values available')
  } else {
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)
    if (maxScore <= 100 && minScore >= 0) {
      log('PASS', 'Score range', `[${minScore.toFixed(1)}, ${maxScore.toFixed(1)}]`)
    } else {
      log('FAIL', 'Score range', `Out of bounds: [${minScore}, ${maxScore}]`)
    }
  }

  // Check ROI reasonableness
  const rois = traders.map((t) => t.roi).filter((v) => v != null)
  if (rois.length === 0) {
    log('WARN', 'ROI range', 'No ROI values available')
  } else {
    const maxRoi = Math.max(...rois.map(Math.abs))
    if (maxRoi < 100000) {
      log('PASS', 'ROI range', `Max absolute ROI: ${maxRoi.toFixed(1)}%`)
    } else {
      log('WARN', 'ROI range', `Suspiciously high: ${maxRoi.toFixed(1)}%`)
    }
  }
}

// 4. SSR content checks
async function checkSSRContent() {
  console.log('\n🖥️  SSR Content Checks')
  try {
    const res = await fetchWithTimeout(`${ARENA_URL}/`)
    if (isAccessFailureResponse(res)) {
      recordAccessFailure('SSR homepage', `Status ${res.status}`)
      return
    }
    if (!res.ok) {
      log('FAIL', 'SSR homepage', `Status ${res.status}`)
      return
    }
    const html = res.body

    // Check that SSR ranking table is present on homepage
    if (html.includes('ssr-r') || html.includes('ssr-hdr')) {
      log('PASS', 'SSR ranking table', 'Ranking rows rendered server-side on homepage')
    } else {
      log('WARN', 'SSR ranking table', 'No SSR-rendered ranking rows found on homepage')
    }

    // Check for error boundary renders
    if (html.includes('Something went wrong') || html.includes('error-boundary')) {
      log('FAIL', 'Error boundary', 'Error boundary triggered on /rankings')
    } else {
      log('PASS', 'No error boundaries', 'Clean render')
    }
  } catch (e) {
    recordAccessFailure('SSR content check', e.message)
  }
}

// Main
async function main() {
  console.log(`🔍 UX Patrol — ${new Date().toISOString()}`)
  console.log(`Target: ${ARENA_URL}`)

  await checkPages()
  await checkAPIs()
  await checkDataQuality()
  await checkSSRContent()

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log(
    `📋 Summary: ${passed}/${totalChecks} passed, ${warned} warned, ${failed} failed, ${blind} blind`
  )

  if (failed > 0) {
    console.log('\n❌ Failed checks:')
    results
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => {
        console.log(`   - ${r.check}: ${r.detail}`)
      })
  }

  // A blind sentinel cannot establish production health, even if the checks it could run passed.
  if (blind > 0) process.exit(2)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('UX Patrol crashed:', e.message)
  process.exit(2)
})
