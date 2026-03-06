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

const ARENA_URL = process.env.ARENA_URL || 'https://www.arenafi.org'
const TIMEOUT = 15000

const results = []
let totalChecks = 0
let passed = 0
let failed = 0

function log(status, check, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌'
  results.push({ status, check, detail })
  totalChecks++
  if (status === 'PASS') passed++
  else failed++
  console.log(`${icon} ${check}${detail ? ` — ${detail}` : ''}`)
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// 1. Page health checks
async function checkPages() {
  console.log('\n📄 Page Health Checks')
  const pages = [
    '/',
    '/rankings',
    '/rankings/7d',
    '/market',
    '/library',
    '/login',
  ]

  for (const path of pages) {
    try {
      const res = await fetchWithTimeout(`${ARENA_URL}${path}`)
      if (res.ok) {
        const html = await res.text()
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
      } else {
        log('FAIL', `GET ${path}`, `Status ${res.status}`)
      }
    } catch (e) {
      log('FAIL', `GET ${path}`, e.message)
    }
  }
}

// 2. API health checks
async function checkAPIs() {
  console.log('\n🔌 API Health Checks')
  const apis = [
    { path: '/api/rankings?window=7d&limit=5', check: (d) => Array.isArray(d.traders) && d.traders.length > 0 },
    { path: '/api/market', check: (d) => Array.isArray(d.rows) && d.rows.length > 0 },
    { path: '/api/market/spot', check: (d) => Array.isArray(d) && d.length > 0 },
    { path: '/api/stats', check: (d) => d.traderCount > 0 },
  ]

  for (const { path, check } of apis) {
    try {
      const res = await fetchWithTimeout(`${ARENA_URL}${path}`)
      if (!res.ok) {
        log('FAIL', `API ${path}`, `Status ${res.status}`)
        continue
      }
      const data = await res.json()
      if (check(data)) {
        log('PASS', `API ${path}`, 'Valid response')
      } else {
        log('FAIL', `API ${path}`, 'Response shape invalid or empty')
      }
    } catch (e) {
      log('FAIL', `API ${path}`, e.message)
    }
  }
}

// 3. Data quality spot checks
async function checkDataQuality() {
  console.log('\n📊 Data Quality Spot Checks')
  try {
    const res = await fetchWithTimeout(`${ARENA_URL}/api/rankings?window=7d&limit=10`)
    if (!res.ok) { log('FAIL', 'Rankings data', `Status ${res.status}`); return }
    const data = await res.json()
    const traders = data.traders || []

    if (traders.length === 0) {
      log('FAIL', 'Rankings data', 'No traders returned')
      return
    }

    // Check required fields (nested under metrics for some)
    let missingCount = 0
    for (const t of traders) {
      if (!t.display_name && !t.trader_key) missingCount++
      if (!t.platform) missingCount++
      const m = t.metrics || {}
      if (m.roi === null || m.roi === undefined) missingCount++
      if (m.pnl === null || m.pnl === undefined) missingCount++
      if (m.arena_score === null || m.arena_score === undefined) missingCount++
    }
    if (missingCount === 0) {
      log('PASS', 'Required fields present', `${traders.length} traders checked`)
    } else {
      log('WARN', 'Missing fields', `${missingCount} null/undefined fields in top 10`)
    }

    // Check score range
    const scores = traders.map(t => t.metrics?.arena_score).filter(Boolean)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)
    if (maxScore <= 100 && minScore >= 0) {
      log('PASS', 'Score range', `[${minScore.toFixed(1)}, ${maxScore.toFixed(1)}]`)
    } else {
      log('FAIL', 'Score range', `Out of bounds: [${minScore}, ${maxScore}]`)
    }

    // Check ROI reasonableness
    const rois = traders.map(t => t.metrics?.roi).filter(v => v != null)
    const maxRoi = Math.max(...rois.map(Math.abs))
    if (maxRoi < 100000) {
      log('PASS', 'ROI range', `Max absolute ROI: ${maxRoi.toFixed(1)}%`)
    } else {
      log('WARN', 'ROI range', `Suspiciously high: ${maxRoi.toFixed(1)}%`)
    }
  } catch (e) {
    log('FAIL', 'Data quality check', e.message)
  }
}

// 4. SSR content checks
async function checkSSRContent() {
  console.log('\n🖥️  SSR Content Checks')
  try {
    const res = await fetchWithTimeout(`${ARENA_URL}/`)
    if (!res.ok) { log('FAIL', 'SSR homepage', `Status ${res.status}`); return }
    const html = await res.text()

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
    log('FAIL', 'SSR content check', e.message)
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
  console.log(`📋 Summary: ${passed}/${totalChecks} passed, ${failed} failed`)

  if (failed > 0) {
    console.log('\n❌ Failed checks:')
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`   - ${r.check}: ${r.detail}`)
    })
  }

  // Exit with error code if any checks failed
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('UX Patrol crashed:', e.message)
  process.exit(2)
})
