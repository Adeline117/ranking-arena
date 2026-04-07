#!/usr/bin/env node
/**
 * Homepage Regression Harness
 *
 * Checks that performance optimizations haven't deleted UI components.
 * Any FAIL means a regression — fix before shipping.
 *
 * Required components on homepage:
 * - SSR ranking table with actual trader data
 * - Three-column layout (in Phase 2)
 * - HotDiscussions sidebar component
 * - WatchlistMarket sidebar component
 * - NewsFlash sidebar component
 * - Hero section with stats
 * - TopNav navigation
 */

const SITE_URL = process.env.SITE_URL || 'https://www.arenafi.org'
const results = []

function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ': ' + detail : ''}`)
}

async function main() {
  console.log(`\n🔍 Homepage Regression Check — ${SITE_URL}\n`)

  // ─── 1. Check SSR HTML (server-rendered content) ───
  console.log('Phase 1: SSR HTML checks')
  const res = await fetch(SITE_URL, { headers: { 'Cache-Control': 'no-cache' } })
  const html = await res.text()

  // SSR ranking table exists
  check('SSR ranking table container', html.includes('ssr-ranking-table'), null)

  // SSR has actual trader data (not just empty structure)
  // Look for arena score numbers in SSR rows
  const hasTraderData = (html.match(/ssr-score-val|ssr-roi-val/g) || []).length >= 5
  check('SSR table has trader data (≥5 rows)', hasTraderData,
    `found ${(html.match(/ssr-score-val|ssr-roi-val/g) || []).length} score/roi elements`)

  // TopNav present
  check('TopNav present', html.includes('ssr-topnav'), null)

  // Hero stats (check for K+ pattern = real data, not empty)
  const kPlusMatches = html.match(/\d+K\+/g) || []
  check('Hero stats with real numbers', kPlusMatches.length >= 1,
    `found: ${kPlusMatches.join(', ')}`)

  // ─── 2. Check codebase (components exist in source) ───
  console.log('\nPhase 2: Source code component checks')
  const { readFileSync, existsSync } = await import('fs')

  const homePage = readFileSync('app/components/home/HomePage.tsx', 'utf8')

  check('ThreeColumnLayout imported', homePage.includes('ThreeColumnLayout'), null)
  check('HotDiscussions imported', homePage.includes('HotDiscussions'), null)
  check('WatchlistMarket imported', homePage.includes('WatchlistMarket'), null)
  check('NewsFlash imported', homePage.includes('NewsFlash'), null)

  // Verify components are actually RENDERED (not just imported)
  check('ThreeColumnLayout rendered', homePage.includes('<ThreeColumnLayout'), null)
  check('HotDiscussions rendered', homePage.includes('<HotDiscussions'), null)
  check('WatchlistMarket rendered', homePage.includes('<WatchlistMarket'), null)
  check('NewsFlash rendered', homePage.includes('<NewsFlash'), null)

  // Check page.tsx has HomePageLoader (Phase 2 entry point)
  const pageFile = readFileSync('app/page.tsx', 'utf8')
  check('page.tsx imports HomePageLoader', pageFile.includes('HomePageLoader'), null)
  check('page.tsx renders HomePageLoader', pageFile.includes('<HomePageLoader'), null)
  check('page.tsx renders SSRRankingTable', pageFile.includes('<SSRRankingTable'), null)

  // ─── 3. Summary ───
  console.log('\n' + '═'.repeat(50))
  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  console.log(`  ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    console.log('\n  ❌ FAIL — Homepage has regressions:')
    for (const r of results.filter(r => !r.pass)) {
      console.log(`     - ${r.name}`)
    }
    process.exit(1)
  } else {
    console.log('  ✅ PASS — All homepage components verified')
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
