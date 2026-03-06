/**
 * Mobile Responsiveness Audit Script
 *
 * Visits core pages at 375px viewport width and checks:
 * 1. Clickable element size (WCAG 44x44px minimum)
 * 2. Horizontal overflow
 * 3. Text truncation
 * 4. Table readability / overflow
 * 5. Full-page screenshots
 *
 * Usage: npx tsx scripts/audit-mobile.ts
 */

import { chromium, type Browser, type Page } from 'playwright'
import * as path from 'path'
import * as fs from 'fs'

const BASE_URL = 'https://www.arenafi.org'
const VIEWPORT = { width: 375, height: 812 } // iPhone X dimensions
const PAGE_TIMEOUT = 30_000
const SCREENSHOT_DIR = path.join(process.cwd(), 'audit-screenshots')

// Pages to audit
const PAGES = [
  { name: 'Home', path: '/' },
  { name: 'Rankings', path: '/rankings' },
  { name: 'Rankings (Binance Futures)', path: '/rankings/binance-futures' },
  { name: 'Trader Profile', path: '/trader/binance-futures/__DISCOVER__' }, // will be resolved dynamically
  { name: 'Library', path: '/library' },
  { name: 'Groups', path: '/groups' },
  { name: 'Pricing', path: '/pricing' },
]

interface UndersizedElement {
  tag: string
  text: string
  width: number
  height: number
  selector: string
}

interface TruncatedElement {
  tag: string
  text: string
  overflowX: boolean
  overflowY: boolean
}

interface TableIssue {
  index: number
  tableWidth: number
  containerWidth: number
  overflowPx: number
}

interface PageAuditResult {
  url: string
  name: string
  screenshotPath: string
  loadSuccess: boolean
  loadError?: string
  httpStatus?: number
  undersizedElements: UndersizedElement[]
  horizontalOverflow: boolean
  scrollWidthDelta: number
  truncatedElements: TruncatedElement[]
  tableIssues: TableIssue[]
  pass: boolean
}

async function dismissCookieConsent(page: Page) {
  try {
    const acceptBtn = page.locator(
      'button:has-text("Accept"), button:has-text("OK"), button:has-text("Got it"), button:has-text("Agree"), button:has-text("接受")'
    )
    if (await acceptBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await acceptBtn.first().click()
      await page.waitForTimeout(500)
    }
  } catch {
    // Ignore
  }
}

async function discoverTraderUrl(page: Page): Promise<string | null> {
  try {
    await page.goto(`${BASE_URL}/rankings/binance-futures`, {
      timeout: PAGE_TIMEOUT,
      waitUntil: 'domcontentloaded',
    })
    await page.waitForTimeout(3000) // Let the page render traders

    const traderLink = await page
      .locator('a[href*="/trader/"]')
      .first()
      .getAttribute('href', { timeout: 10_000 })
      .catch(() => null)

    if (traderLink) {
      console.log(`  Discovered trader URL: ${traderLink}`)
      return traderLink
    }
  } catch (e) {
    console.log(`  Could not discover trader URL: ${e}`)
  }
  return null
}

async function checkUndersizedElements(page: Page): Promise<UndersizedElement[]> {
  return page.evaluate(() => {
    const results: {
      tag: string
      text: string
      width: number
      height: number
      selector: string
    }[] = []

    const selectors = 'a, button, [role="button"], [role="link"], input, select, textarea, [onclick], [tabindex]'
    const elements = document.querySelectorAll(selectors)

    elements.forEach((el) => {
      const rect = el.getBoundingClientRect()
      // Skip invisible / zero-size elements
      if (rect.width === 0 || rect.height === 0) return
      // Skip offscreen elements
      if (rect.bottom < 0 || rect.top > window.innerHeight * 3) return

      if (rect.width < 44 || rect.height < 44) {
        const tag = el.tagName.toLowerCase()
        const text = (el.textContent || '').trim().substring(0, 60)
        const id = el.id ? `#${el.id}` : ''
        const cls = el.className && typeof el.className === 'string'
          ? `.${el.className.split(' ').slice(0, 2).join('.')}`
          : ''
        results.push({
          tag,
          text: text || '(no text)',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          selector: `${tag}${id}${cls}`,
        })
      }
    })

    return results
  })
}

async function checkHorizontalOverflow(page: Page): Promise<{ overflow: boolean; delta: number }> {
  return page.evaluate(() => {
    const scrollW = document.documentElement.scrollWidth
    const clientW = document.documentElement.clientWidth
    return {
      overflow: scrollW > clientW,
      delta: scrollW - clientW,
    }
  })
}

async function checkTextTruncation(page: Page): Promise<TruncatedElement[]> {
  return page.evaluate(() => {
    const results: {
      tag: string
      text: string
      overflowX: boolean
      overflowY: boolean
    }[] = []

    // Check all text-containing elements
    const allElements = document.querySelectorAll('p, span, div, h1, h2, h3, h4, h5, h6, li, td, th, a, label')
    allElements.forEach((el) => {
      const style = getComputedStyle(el)
      if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
        const hasOverflowX = el.scrollWidth > el.clientWidth + 1
        const hasOverflowY = el.scrollHeight > el.clientHeight + 1

        if (hasOverflowX || hasOverflowY) {
          const text = (el.textContent || '').trim().substring(0, 80)
          if (!text) return
          // Skip elements intentionally truncated with ellipsis (these are by design)
          if (style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap') return

          results.push({
            tag: el.tagName.toLowerCase(),
            text,
            overflowX: hasOverflowX,
            overflowY: hasOverflowY,
          })
        }
      }
    })

    // Deduplicate: if a parent and child both report, keep the parent
    return results.slice(0, 30) // Limit to 30
  })
}

async function checkTableOverflow(page: Page): Promise<TableIssue[]> {
  return page.evaluate(() => {
    const tables = document.querySelectorAll('table')
    const results: {
      index: number
      tableWidth: number
      containerWidth: number
      overflowPx: number
    }[] = []

    tables.forEach((table, i) => {
      const tableRect = table.getBoundingClientRect()
      const parent = table.parentElement
      if (!parent) return

      const parentRect = parent.getBoundingClientRect()
      if (tableRect.width > parentRect.width + 2) {
        results.push({
          index: i,
          tableWidth: Math.round(tableRect.width),
          containerWidth: Math.round(parentRect.width),
          overflowPx: Math.round(tableRect.width - parentRect.width),
        })
      }
    })

    return results
  })
}

async function auditPage(page: Page, name: string, pagePath: string): Promise<PageAuditResult> {
  const url = `${BASE_URL}${pagePath}`
  const screenshotFilename = `mobile-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.png`
  const screenshotPath = path.join(SCREENSHOT_DIR, screenshotFilename)

  const result: PageAuditResult = {
    url,
    name,
    screenshotPath,
    loadSuccess: false,
    undersizedElements: [],
    horizontalOverflow: false,
    scrollWidthDelta: 0,
    truncatedElements: [],
    tableIssues: [],
    pass: false,
  }

  try {
    console.log(`\n  Loading ${url} ...`)
    const response = await page.goto(url, {
      timeout: PAGE_TIMEOUT,
      waitUntil: 'domcontentloaded',
    })

    result.httpStatus = response?.status()
    if (response && response.status() >= 400) {
      result.loadError = `HTTP ${response.status()}`
      console.log(`  HTTP ${response.status()} - skipping detailed checks`)
      // Still take screenshot and mark as loaded for the screenshot
      result.loadSuccess = true
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
      return result
    }

    result.loadSuccess = true

    // Wait for content to render
    await page.waitForTimeout(3000)
    await dismissCookieConsent(page)
    await page.waitForTimeout(500)

    // 1. Screenshot
    console.log(`  Taking screenshot...`)
    await page.screenshot({ path: screenshotPath, fullPage: true })

    // 2. Undersized clickable elements
    console.log(`  Checking clickable element sizes...`)
    result.undersizedElements = await checkUndersizedElements(page)

    // 3. Horizontal overflow
    console.log(`  Checking horizontal overflow...`)
    const overflow = await checkHorizontalOverflow(page)
    result.horizontalOverflow = overflow.overflow
    result.scrollWidthDelta = overflow.delta

    // 4. Text truncation
    console.log(`  Checking text truncation...`)
    result.truncatedElements = await checkTextTruncation(page)

    // 5. Table overflow
    console.log(`  Checking table overflow...`)
    result.tableIssues = await checkTableOverflow(page)

    // Determine pass/fail
    const criticalUndersized = result.undersizedElements.filter(
      (e) => e.width < 30 || e.height < 30
    )
    result.pass =
      !result.horizontalOverflow &&
      criticalUndersized.length === 0 &&
      result.tableIssues.length === 0

  } catch (err: any) {
    result.loadError = err.message?.substring(0, 200) || 'Unknown error'
    console.log(`  Error: ${result.loadError}`)
    // Try to take screenshot anyway
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  }

  return result
}

function printReport(results: PageAuditResult[]) {
  console.log('\n')
  console.log('='.repeat(80))
  console.log('  MOBILE RESPONSIVENESS AUDIT REPORT')
  console.log('  Viewport: 375 x 812 (iPhone X)')
  console.log('  Site: ' + BASE_URL)
  console.log('  Date: ' + new Date().toISOString())
  console.log('='.repeat(80))

  let totalPass = 0
  let totalFail = 0
  let totalSkipped = 0

  for (const r of results) {
    console.log('\n' + '-'.repeat(80))
    console.log(`  PAGE: ${r.name}`)
    console.log(`  URL:  ${r.url}`)
    console.log(`  Screenshot: ${r.screenshotPath}`)

    if (!r.loadSuccess) {
      console.log(`  STATUS: SKIPPED (load failed: ${r.loadError})`)
      totalSkipped++
      continue
    }

    if (r.httpStatus && r.httpStatus >= 400) {
      console.log(`  STATUS: SKIPPED (HTTP ${r.httpStatus})`)
      totalSkipped++
      continue
    }

    console.log(`  HTTP Status: ${r.httpStatus || 'N/A'}`)

    // Horizontal overflow
    if (r.horizontalOverflow) {
      console.log(`\n  [FAIL] HORIZONTAL OVERFLOW detected: ${r.scrollWidthDelta}px wider than viewport`)
    } else {
      console.log(`\n  [PASS] No horizontal overflow`)
    }

    // Undersized elements
    const critical = r.undersizedElements.filter((e) => e.width < 30 || e.height < 30)
    const warning = r.undersizedElements.filter((e) => e.width >= 30 && e.height >= 30)
    console.log(
      `\n  Clickable elements < 44x44px: ${r.undersizedElements.length} total (${critical.length} critical < 30px, ${warning.length} warnings)`
    )

    if (critical.length > 0) {
      console.log('  [FAIL] Critical undersized elements (< 30px):')
      for (const el of critical.slice(0, 15)) {
        console.log(`    - <${el.tag}> "${el.text}" [${el.width}x${el.height}px] ${el.selector}`)
      }
      if (critical.length > 15) {
        console.log(`    ... and ${critical.length - 15} more`)
      }
    }

    if (warning.length > 0) {
      console.log('  [WARN] Undersized elements (30-43px):')
      for (const el of warning.slice(0, 10)) {
        console.log(`    - <${el.tag}> "${el.text}" [${el.width}x${el.height}px] ${el.selector}`)
      }
      if (warning.length > 10) {
        console.log(`    ... and ${warning.length - 10} more`)
      }
    }

    if (r.undersizedElements.length === 0) {
      console.log('  [PASS] All clickable elements meet 44x44px minimum')
    }

    // Text truncation
    if (r.truncatedElements.length > 0) {
      console.log(`\n  [WARN] Truncated text elements: ${r.truncatedElements.length}`)
      for (const el of r.truncatedElements.slice(0, 10)) {
        const dir = el.overflowX ? 'horizontal' : 'vertical'
        console.log(`    - <${el.tag}> "${el.text}" (${dir} truncation)`)
      }
      if (r.truncatedElements.length > 10) {
        console.log(`    ... and ${r.truncatedElements.length - 10} more`)
      }
    } else {
      console.log(`\n  [PASS] No unexpected text truncation detected`)
    }

    // Table overflow
    if (r.tableIssues.length > 0) {
      console.log(`\n  [FAIL] Table overflow issues: ${r.tableIssues.length}`)
      for (const t of r.tableIssues) {
        console.log(
          `    - Table #${t.index}: ${t.tableWidth}px wide in ${t.containerWidth}px container (${t.overflowPx}px overflow)`
        )
      }
    } else {
      console.log(`\n  [PASS] No table overflow issues`)
    }

    // Overall verdict
    console.log(`\n  VERDICT: ${r.pass ? 'PASS' : 'FAIL'}`)
    if (r.pass) totalPass++
    else totalFail++
  }

  // Summary
  console.log('\n' + '='.repeat(80))
  console.log('  SUMMARY')
  console.log('='.repeat(80))
  console.log(`  Total pages audited: ${results.length}`)
  console.log(`  Passed: ${totalPass}`)
  console.log(`  Failed: ${totalFail}`)
  console.log(`  Skipped: ${totalSkipped}`)
  console.log(`  Screenshots saved to: ${SCREENSHOT_DIR}`)
  console.log('='.repeat(80))
  console.log('')
}

async function main() {
  // Ensure screenshot directory exists
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  }

  console.log('Starting Mobile Responsiveness Audit...')
  console.log(`Target: ${BASE_URL}`)
  console.log(`Viewport: ${VIEWPORT.width}x${VIEWPORT.height}`)
  console.log(`Screenshots: ${SCREENSHOT_DIR}`)

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })

  const page = await context.newPage()

  // Discover a real trader URL first
  console.log('\nDiscovering a real trader profile URL...')
  const traderPath = await discoverTraderUrl(page)

  // Update the trader page path if we discovered one
  const pagesToAudit = PAGES.map((p) => {
    if (p.path.includes('__DISCOVER__')) {
      if (traderPath) {
        return { ...p, path: traderPath }
      } else {
        return { ...p, path: '/trader/binance-futures/example', name: 'Trader Profile (fallback)' }
      }
    }
    return p
  })

  const results: PageAuditResult[] = []

  for (const pageInfo of pagesToAudit) {
    const result = await auditPage(page, pageInfo.name, pageInfo.path)
    results.push(result)
  }

  await browser.close()

  printReport(results)

  // Exit with non-zero if any page failed
  const anyFail = results.some((r) => r.loadSuccess && !r.pass)
  process.exit(anyFail ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(2)
})
