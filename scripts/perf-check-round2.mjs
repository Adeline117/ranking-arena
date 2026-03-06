#!/usr/bin/env node
/**
 * Arena Performance & UX Check - Round 2
 * 全面检测：截图验证、性能测量、用户流程、API响应
 */
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const BASE = 'https://www.arenafi.org'
const OUT = '/tmp/arena-round2-screenshots'
const REPORT_PATH = '/tmp/arena-perf-report.json'

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Pages to test
const PAGES = [
  { name: 'homepage', url: '/', critical: true },
  { name: 'ranking', url: '/ranking', critical: true },
  { name: 'ranking-binance-futures', url: '/ranking/binance_futures', critical: true },
  { name: 'library', url: '/library', critical: false },
  { name: 'pricing', url: '/pricing', critical: false },
  { name: 'login', url: '/login', critical: false },
]

const results = {
  timestamp: new Date().toISOString(),
  screenshots: [],
  api_times: [],
  errors: [],
  db_check: null,
  trader_pages: [],
  summary: {},
}

fs.mkdirSync(OUT, { recursive: true })

// ── Helpers ──────────────────────────────────────────────
function colorize(text, status) {
  const colors = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', reset: '\x1b[0m', cyan: '\x1b[36m' }
  return `${colors[status] || ''}${text}${colors.reset}`
}

async function measureLoad(page, url, label) {
  const start = Date.now()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))

  try {
    const response = await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const statusCode = response?.status()
    await page.waitForTimeout(2500) // Let dynamic content load

    const loadTime = Date.now() - start
    const jsErrors = [...errors]

    // Check for blank/empty content
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() || '')
    const hasContent = bodyText.length > 100
    const hasCriticalBlankAreas = await page.evaluate(() => {
      const main = document.querySelector('main, [role="main"], #__next > div')
      if (!main) return false
      const rect = main.getBoundingClientRect()
      // Check if main content area is essentially empty
      return main.innerText?.trim().length < 50
    })

    return {
      label,
      url,
      loadTime,
      statusCode,
      hasContent,
      hasCriticalBlankAreas,
      jsErrors,
      pass: loadTime < 2000 && hasContent && !hasCriticalBlankAreas && jsErrors.length === 0,
    }
  } catch (e) {
    return {
      label, url,
      loadTime: Date.now() - start,
      error: e.message.slice(0, 100),
      pass: false,
    }
  }
}

// ── 1. API Response Times ────────────────────────────────
async function checkApiTimes() {
  console.log('\n📊 Checking API response times...')
  const endpoints = [
    { name: 'traders-list', url: `${SUPABASE_URL}/rest/v1/traders?select=id,handle,roi,win_rate&order=roi.desc&limit=50` },
    { name: 'ranking-binance-futures', url: `${SUPABASE_URL}/rest/v1/trader_snapshots?select=trader_id,roi,win_rate,pnl&exchange=eq.binance_futures&order=roi.desc&limit=50` },
    { name: 'trader-snapshots-v2', url: `${SUPABASE_URL}/rest/v1/trader_snapshots_v2?select=*&limit=20` },
    { name: 'flash-news', url: `${SUPABASE_URL}/rest/v1/flash_news?select=id,title,created_at&order=created_at.desc&limit=10` },
  ]

  for (const ep of endpoints) {
    const start = Date.now()
    try {
      const res = await fetch(ep.url, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
      })
      const data = await res.json()
      const t = Date.now() - start
      const count = Array.isArray(data) ? data.length : 0
      const status = t < 500 ? 'ok' : t < 1000 ? 'warn' : 'err'
      console.log(`  ${status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌'} ${ep.name}: ${t}ms (${count} rows)`)
      results.api_times.push({ name: ep.name, time: t, rows: count, pass: t < 1000 })
    } catch (e) {
      console.log(`  ❌ ${ep.name}: ERROR - ${e.message.slice(0, 60)}`)
      results.api_times.push({ name: ep.name, error: e.message, pass: false })
    }
  }
}

// ── 2. Get real trader IDs ───────────────────────────────
async function getTraderSamples() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/traders?select=id,handle&limit=15&order=created_at.desc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

// ── 3. DB Stats Check ────────────────────────────────────
async function checkDbStats() {
  console.log('\n🗄️  Checking DB table sizes and indexes...')
  const tables = ['traders', 'trader_snapshots', 'trader_snapshots_v2', 'trader_profiles_v2', 'flash_news', 'ranking_snapshots']
  const stats = {}

  for (const tbl of tables) {
    const start = Date.now()
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${tbl}?select=count`, {
        method: 'HEAD',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'count=exact',
        },
      })
      const count = res.headers.get('content-range')
      const t = Date.now() - start
      stats[tbl] = { count: count || 'unknown', queryTime: t }
      console.log(`  ${tbl}: ${count || 'unknown'} rows, ${t}ms`)
    } catch (e) {
      stats[tbl] = { error: e.message }
    }
  }

  results.db_check = stats
}

// ── 4. Screenshot All Pages ──────────────────────────────
async function screenshotPages(browser, traders) {
  console.log('\n📸 Taking screenshots of all key pages...')

  const allPages = [...PAGES]
  // Add 5 trader pages
  traders.slice(0, 5).forEach((t, i) => {
    allPages.push({ name: `trader-${i+1}-${t.handle || t.id}`, url: `/trader/${t.handle || t.id}`, critical: true })
  })

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  for (const p of allPages) {
    console.log(`  Testing: ${p.url}`)
    const result = await measureLoad(page, p.url, p.name)

    // Screenshot
    const screenshotPath = `${OUT}/${p.name}.jpg`
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false, type: 'jpeg', quality: 85 })
    } catch (e) {
      result.screenshotError = e.message.slice(0, 60)
    }

    result.screenshotPath = screenshotPath

    const icon = result.pass ? '✅' : '❌'
    const timeColor = result.loadTime < 1000 ? 'fast' : result.loadTime < 2000 ? 'ok' : 'slow'
    console.log(`    ${icon} ${p.name}: ${result.loadTime}ms | content:${result.hasContent} | blank:${result.hasCriticalBlankAreas} | jsErr:${result.jsErrors?.length || 0}`)

    if (result.jsErrors?.length > 0) {
      result.jsErrors.slice(0, 3).forEach(e => console.log(`       JS Error: ${e.slice(0, 80)}`))
    }

    if (p.name.startsWith('trader-')) {
      results.trader_pages.push(result)
    } else {
      results.screenshots.push(result)
    }
  }

  await ctx.close()
}

// ── 5. User Flow Test ────────────────────────────────────
async function testUserFlow(browser) {
  console.log('\n🧪 Testing user flow...')
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const flow = []

  async function step(name, fn) {
    const start = Date.now()
    try {
      await fn()
      const t = Date.now() - start
      flow.push({ step: name, time: t, pass: true })
      console.log(`  ✅ ${name}: ${t}ms`)
    } catch (e) {
      const t = Date.now() - start
      flow.push({ step: name, time: t, pass: false, error: e.message.slice(0, 100) })
      console.log(`  ❌ ${name}: ${e.message.slice(0, 80)}`)
    }
  }

  await step('Load homepage', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(2000)
  })

  await step('Navigate to ranking', async () => {
    await page.goto(BASE + '/ranking', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(2000)
  })

  await step('Ranking has data rows', async () => {
    // Check if ranking table has rows (any link to trader pages)
    const traderLinks = await page.$$('a[href*="/trader/"]')
    if (traderLinks.length === 0) throw new Error('No trader links found on ranking page')
    console.log(`     Found ${traderLinks.length} trader links`)
  })

  await step('Navigate to Binance Futures ranking', async () => {
    await page.goto(BASE + '/ranking/binance_futures', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(2000)
  })

  await step('Click first trader', async () => {
    const link = await page.$('a[href*="/trader/"]')
    if (!link) throw new Error('No trader link to click')
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      link.click(),
    ])
    await page.waitForTimeout(2000)
  })

  await step('Trader detail has stats', async () => {
    const text = await page.evaluate(() => document.body?.innerText || '')
    if (text.length < 100) throw new Error('Trader detail page seems empty')
    // Check for key stats
    const hasROI = /roi|ROI|盈利|win/i.test(text)
    if (!hasROI) throw new Error('No ROI/stats found on trader page')
  })

  await step('Navigate back to ranking', async () => {
    await page.goto(BASE + '/ranking', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1500)
  })

  await step('Navigate to login page', async () => {
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1500)
    const text = await page.evaluate(() => document.body?.innerText || '')
    if (text.length < 50) throw new Error('Login page seems empty')
  })

  await ctx.close()
  results.user_flow = flow
  return flow
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  🏟️  Arena Performance & UX Round 2 Check')
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('═══════════════════════════════════════════════════════')

  // 1. API times
  await checkApiTimes()

  // 2. DB stats
  await checkDbStats()

  // 3. Get trader samples
  const traders = await getTraderSamples()
  console.log(`\n👥 Got ${traders.length} trader samples`)

  // 4. Launch browser
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })

  try {
    // 5. Screenshots + load time
    await screenshotPages(browser, traders)

    // 6. User flow
    await testUserFlow(browser)
  } finally {
    await browser.close()
  }

  // ── Summary ──────────────────────────────────────────
  const allPageResults = [...results.screenshots, ...results.trader_pages]
  const passing = allPageResults.filter(r => r.pass).length
  const failing = allPageResults.filter(r => !r.pass).length
  const slowPages = allPageResults.filter(r => r.loadTime > 2000)
  const blankPages = allPageResults.filter(r => r.hasCriticalBlankAreas)
  const jsErrorPages = allPageResults.filter(r => r.jsErrors?.length > 0)
  const avgLoadTime = allPageResults.reduce((s, r) => s + (r.loadTime || 0), 0) / allPageResults.length

  const apiPass = results.api_times.filter(r => r.pass).length
  const apiAvg = results.api_times.reduce((s, r) => s + (r.time || 0), 0) / results.api_times.length

  const flowPass = results.user_flow?.filter(r => r.pass).length || 0
  const flowTotal = results.user_flow?.length || 0

  results.summary = {
    pages: { total: allPageResults.length, passing, failing },
    slowPages: slowPages.map(p => ({ name: p.label, time: p.loadTime })),
    blankPages: blankPages.map(p => p.label),
    jsErrorPages: jsErrorPages.map(p => p.label),
    avgLoadTime: Math.round(avgLoadTime),
    api: { avg: Math.round(apiAvg), passing: apiPass, total: results.api_times.length },
    flow: { passing: flowPass, total: flowTotal },
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log('  📊 SUMMARY')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Pages:  ${passing}✅ / ${failing}❌ (avg load: ${Math.round(avgLoadTime)}ms)`)
  console.log(`  API:    ${apiPass}✅ / ${results.api_times.length - apiPass}❌ (avg: ${Math.round(apiAvg)}ms)`)
  console.log(`  Flow:   ${flowPass}/${flowTotal} steps passed`)
  if (slowPages.length > 0) console.log(`  ⚠️  Slow pages (>2s): ${slowPages.map(p => p.label + '(' + p.loadTime + 'ms)').join(', ')}`)
  if (blankPages.length > 0) console.log(`  ⚠️  Blank pages: ${blankPages.join(', ')}`)
  if (jsErrorPages.length > 0) console.log(`  ⚠️  JS errors: ${jsErrorPages.join(', ')}`)
  console.log(`\n  Screenshots: ${OUT}/`)

  // Save report
  fs.writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2))
  console.log(`  Full report: ${REPORT_PATH}`)
  console.log('═══════════════════════════════════════════════════════\n')

  return results
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
