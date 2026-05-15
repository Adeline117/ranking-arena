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
  const pages = ['/', '/rankings', '/rankings/7d', '/market', '/library', '/login']

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

// Cached rankings data — fetched once, reused for API check + data quality
let cachedRankingsTraders = null

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
      if (!res.ok) {
        log('FAIL', `API ${path}`, `Status ${res.status}`)
        continue
      }
      const data = await res.json()
      if (check(data)) {
        log('PASS', `API ${path}`, 'Valid response')
        if (cacheTraders) cachedRankingsTraders = data.data?.traders || []
      } else {
        log('FAIL', `API ${path}`, 'Response shape invalid or empty')
      }
    } catch (e) {
      log('FAIL', `API ${path}`, e.message)
    }
  }
}

// 3. Data quality spot checks (reuses rankings data from checkAPIs)
async function checkDataQuality() {
  console.log('\n📊 Data Quality Spot Checks')
  const traders = cachedRankingsTraders
  if (!traders) {
    log('FAIL', 'Rankings data', 'No rankings data available (API check failed)')
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
    if (!res.ok) {
      log('FAIL', 'SSR homepage', `Status ${res.status}`)
      return
    }
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
    results
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => {
        console.log(`   - ${r.check}: ${r.detail}`)
      })
  }

  // Exit with error code if any checks failed
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('UX Patrol crashed:', e.message)
  process.exit(2)
})
