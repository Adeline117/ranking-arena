#!/usr/bin/env node
// Verify the React #418 hydration mismatch on the no-provider pages (/ and /rankings).
//
// Repro: those pages render RankingControls/useRankingFilters/RankingFooter OUTSIDE
// LanguageProvider (homepage omits Providers for LCP). The useLanguage() fallback
// used to read localStorage on the first client render while SSR rendered 'en',
// producing "Minified React error #418" for any non-English user.
//
// Usage: BASE_URL=https://www.arenafi.org node scripts/qa/verify-418-hydration.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'https://www.arenafi.org'
const ROUTES = ['/', '/rankings']
const LANG = process.env.LANG_CODE || 'zh' // non-English triggers the mismatch

const browser = await chromium.launch()
let anyFail = false

for (const route of ROUTES) {
  const ctx = await browser.newContext()
  // Seed the saved language BEFORE the page's scripts run.
  await ctx.addInitScript((lang) => {
    try {
      localStorage.setItem('language', lang)
    } catch {}
  }, LANG)
  const page = await ctx.newPage()

  const hydrationErrors = []
  page.on('console', (msg) => {
    const txt = msg.text()
    if (
      /Minified React error #41[8-9]/.test(txt) ||
      /error #42[0-3]/.test(txt) ||
      /hydrat/i.test(txt) ||
      /did not match|Text content does not match/i.test(txt)
    ) {
      hydrationErrors.push(txt.slice(0, 200))
    }
  })
  page.on('pageerror', (err) => {
    const txt = String(err)
    if (/Minified React error #41[8-9]/.test(txt) || /hydrat/i.test(txt)) {
      hydrationErrors.push(txt.slice(0, 200))
    }
  })

  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(2500) // let hydration + async i18n settle

  const status = hydrationErrors.length === 0 ? 'PASS' : 'FAIL'
  if (status === 'FAIL') anyFail = true
  console.log(`[${status}] ${route} (lang=${LANG}) — ${hydrationErrors.length} hydration error(s)`)
  for (const e of hydrationErrors.slice(0, 3)) console.log(`        ${e}`)

  await ctx.close()
}

await browser.close()
console.log(anyFail ? '\nRESULT: #418 still present' : '\nRESULT: no #418 hydration errors ✅')
process.exit(anyFail ? 1 : 0)
