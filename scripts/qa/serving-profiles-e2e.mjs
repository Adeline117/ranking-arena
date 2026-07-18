#!/usr/bin/env node
/**
 * Serving-source profile end-to-end render verification.
 *
 * WHY THIS EXISTS (root-cause guard, 2026-06-12): the data-layer rebuild
 * shipped 34 sources whose unit tests + DB-row smokes all passed, yet a
 * dormant-trader profile rendered a half-screen empty chart in production —
 * because NO step opened a real browser on real data. "Tests green" ≠
 * "users see correct pages". This script closes that gap: it pulls ONE live
 * representative trader per serving source straight from arena.*, opens each
 * profile in a headless browser against production (or a base URL), and
 * fails on HTTP errors, i18n key leaks, console errors, empty pages, or
 * blown-up empty charts. Run it after any serving-source or serving-UI
 * change, and after activating a new source.
 *
 * Usage:
 *   INGEST_DATABASE_URL=... node scripts/qa/serving-profiles-e2e.mjs [baseUrl]
 *   (baseUrl defaults to https://www.arenafi.org)
 */
import { chromium } from 'playwright'
import pg from 'pg'
import { config } from 'dotenv'
import { resolve } from 'path'
import { servingPageReadiness } from './serving-page-readiness.mjs'

config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

const BASE = process.argv[2] || process.env.PLAYWRIGHT_BASE_URL || 'https://www.arenafi.org'

const KEY_LEAK =
  /\b(metric[A-Z]\w+|tab[A-Z]\w+|tf[A-Z]\w+|provenance[A-Z]\w+|col[A-Z]\w+|trader[A-Z][a-z]\w+|copier[A-Z]\w+|signal[A-Z]\w+|moduleData\w+|botStrategy\w+)\b/

async function pickRepresentatives() {
  const url = process.env.INGEST_DATABASE_URL || process.env.DATABASE_URL
  if (!url) throw new Error('INGEST_DATABASE_URL not set')
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  })
  await client.connect()
  // One active trader per serving source (prefer non-zero ROI = a page with
  // content) + one dormant trader (all-zero) to lock the empty-state fix.
  const { rows } = await client.query(`
    SELECT DISTINCT ON (s.slug) s.slug, s.currency, t.exchange_trader_id
    FROM arena.trader_stats st
    JOIN arena.traders t ON t.id = st.trader_id
    JOIN arena.sources s ON s.id = t.source_id
    WHERE s.serving_mode = 'serving' AND st.timeframe = 30
      AND st.roi IS NOT NULL AND st.roi <> 0
    ORDER BY s.slug, st.roi DESC NULLS LAST
  `)
  const dormant = await client.query(`
    SELECT s.slug, t.exchange_trader_id
    FROM arena.trader_stats st
    JOIN arena.traders t ON t.id = st.trader_id
    JOIN arena.sources s ON s.id = t.source_id
    WHERE s.serving_mode = 'serving' AND st.timeframe = 30
      AND COALESCE(st.roi,0) = 0 AND st.extras ? 'style_labels'
    LIMIT 1
  `)
  await client.end()
  const cases = rows.map((r) => ({ slug: r.slug, id: r.exchange_trader_id, kind: 'active' }))
  if (dormant.rows[0]) {
    cases.push({
      slug: dormant.rows[0].slug,
      id: dormant.rows[0].exchange_trader_id,
      kind: 'dormant',
    })
  }
  return cases
}

async function checkPage(browser, url, label, expectDormant) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } })
  const errs = []
  const unexpectedHttp = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 90))
  })
  page.on('pageerror', (e) => errs.push('PE:' + String(e).slice(0, 90)))
  page.on('response', (response) => {
    if (response.status() < 400) return
    const request = response.request()
    const path = new URL(response.url()).pathname
    unexpectedHttp.push(`${response.status()} ${request.method()} ${path}`.slice(0, 120))
  })
  let status = 0
  const readiness = servingPageReadiness(label)
  try {
    const resp = await page.goto(url, { waitUntil: readiness.waitUntil, timeout: 40000 })
    status = resp?.status() ?? 0
    if (readiness.readySelector) {
      await page
        .locator(readiness.readySelector)
        .first()
        .waitFor({ state: 'visible', timeout: readiness.readyTimeoutMs })
    }
    await page.waitForTimeout(readiness.observeMs)
  } catch (e) {
    await page.close()
    return { label, ok: false, why: 'NAV ' + String(e).slice(0, 50) }
  }
  const txt = await page.evaluate(() => document.body.innerText)
  // Oversized empty chart heuristic: a chart canvas/svg with almost no text
  // around it in the chart region. Simpler proxy: dormant pages must show
  // the dormant notice, never a lone chart.
  const leak = KEY_LEAK.exec(txt)
  const problems = []
  if (status !== 200) problems.push('http=' + status)
  if (leak) problems.push('i18n-leak:' + leak[0])
  if (errs.length) problems.push('console=' + errs.length + '(' + errs[0] + ')')
  if (unexpectedHttp.length) {
    problems.push(`network=${unexpectedHttp.length}(${unexpectedHttp[0]})`)
  }
  if (txt.length < 400) problems.push('empty(' + txt.length + ')')
  if (
    expectDormant &&
    !/No trading activity|无交易活动|取引活動はありません|거래 활동이 없습니다/.test(txt)
  ) {
    problems.push('dormant-notice-missing')
  }
  await page.close()
  return { label, ok: problems.length === 0, why: problems.join(',') }
}

const browser = await chromium.launch({ headless: true })
const cases = await pickRepresentatives()
console.log(`QA against ${BASE} — ${cases.length} serving profiles`)
const results = []

// Core product paths first
for (const [path, label] of [
  ['/', 'home'],
  ['/rankings/exchanges', 'exchanges'],
  ['/rankings/weekly', 'weekly'],
]) {
  results.push(await checkPage(browser, BASE + path, label, false))
}
for (const c of cases) {
  const url = `${BASE}/trader/${encodeURIComponent(c.id)}?source=${c.slug}`
  results.push(await checkPage(browser, url, `${c.kind}:${c.slug}`, c.kind === 'dormant'))
}

let fails = 0
for (const r of results) {
  if (!r.ok) fails++
  console.log(`${r.ok ? '✅' : '❌'} ${r.label.padEnd(26)} ${r.why}`)
}
console.log(`\n${results.length - fails}/${results.length} OK`)
await browser.close()
process.exit(fails > 0 ? 1 : 0)
