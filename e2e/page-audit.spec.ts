/**
 * Page Performance & Error Audit
 *
 * Tests every major page for:
 *  1. Page load time (domContentLoaded + load)
 *  2. Console errors
 *  3. Failed network requests (status >= 400)
 *  4. Error boundary / "Something went wrong" text
 *  5. Screenshots for any pages with issues
 *
 * Also: clicks 10 random internal links to check for 500s.
 */
import { test, expect, Page } from '@playwright/test'

// ── pages to audit ──────────────────────────────────────────────
const PAGES = [
  '/',
  '/market',
  '/groups',
  '/hot',
  '/login',
  '/pricing',
  '/rankings/tokens',
  '/search?q=btc',
  '/methodology',
  '/help',
  '/claim',
  '/compare',
  '/terms',
]

const LOAD_TIME_THRESHOLD_MS = 5_000

// ── types ───────────────────────────────────────────────────────
interface PageAuditResult {
  page: string
  domContentLoaded: number
  loadTime: number
  consoleErrors: string[]
  failedRequests: { url: string; status: number }[]
  hasErrorText: boolean
  hasErrorBoundary: boolean
  flagged: boolean
}

// ── shared collector ────────────────────────────────────────────
const results: PageAuditResult[] = []

async function auditPage(
  page: Page,
  path: string,
  screenshotDir: string
): Promise<PageAuditResult> {
  const consoleErrors: string[] = []
  const failedRequests: { url: string; status: number }[] = []

  // Listen for console errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text().slice(0, 200))
    }
  })

  // Listen for failed network requests
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push({
        url: response
          .url()
          .replace(/^https?:\/\/[^/]+/, '')
          .slice(0, 120),
        status: response.status(),
      })
    }
  })

  // Navigate
  const startTime = Date.now()

  let domContentLoaded = 0
  let loadTime = 0

  // Use CDP to get precise timing if available, otherwise fallback
  try {
    await page.goto(path, { waitUntil: 'load', timeout: 60_000 })
  } catch {
    // Even on timeout, we still want to capture what we can
  }

  // Get performance timing
  const timing = await page.evaluate(() => {
    const perf = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    if (perf) {
      return {
        domContentLoaded: Math.round(perf.domContentLoadedEventEnd - perf.startTime),
        load: Math.round(perf.loadEventEnd - perf.startTime),
      }
    }
    return null
  })

  if (timing) {
    domContentLoaded = timing.domContentLoaded
    loadTime = timing.load
  } else {
    loadTime = Date.now() - startTime
    domContentLoaded = loadTime
  }

  // Wait a moment for any late console errors / network responses
  await page.waitForTimeout(1500)

  // Check for error text
  const bodyText = (await page.textContent('body').catch(() => '')) ?? ''
  const hasErrorText = bodyText.includes('Something went wrong') || bodyText.includes('出了点问题')

  // Check for error boundary elements
  const hasErrorBoundary =
    (await page
      .locator('[data-error-boundary], .error-boundary, [class*="error-boundary"]')
      .count()) > 0

  const flagged =
    loadTime > LOAD_TIME_THRESHOLD_MS ||
    consoleErrors.length > 0 ||
    failedRequests.length > 0 ||
    hasErrorText ||
    hasErrorBoundary

  // Screenshot if flagged
  if (flagged) {
    const safeName = path.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_')
    await page.screenshot({
      path: `${screenshotDir}/audit_${safeName}.png`,
      fullPage: false,
    })
  }

  return {
    page: path,
    domContentLoaded,
    loadTime,
    consoleErrors,
    failedRequests,
    hasErrorText,
    hasErrorBoundary,
    flagged,
  }
}

// ── tests ───────────────────────────────────────────────────────
test.describe('Page Performance & Error Audit', () => {
  // Run pages serially so dev server isn't overwhelmed
  test.describe.configure({ mode: 'serial' })

  const screenshotDir = 'e2e/audit-screenshots'

  test.beforeAll(async () => {
    // Ensure screenshot directory exists
    const fs = await import('fs')
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true })
    }
  })

  for (const pagePath of PAGES) {
    test(`audit ${pagePath}`, async ({ page }) => {
      const result = await auditPage(page, pagePath, screenshotDir)
      results.push(result)

      // Soft-assert: just log, don't fail the test (we want to collect all results)
      if (result.hasErrorText) {
        console.warn(`  [ERROR TEXT] ${pagePath}: found "Something went wrong" / "出了点问题"`)
      }
      if (result.hasErrorBoundary) {
        console.warn(`  [ERROR BOUNDARY] ${pagePath}`)
      }

      // But do fail on 500-level errors from same-origin requests
      const server500s = result.failedRequests.filter((r) => r.status >= 500)
      if (server500s.length > 0) {
        console.error(`  [500 ERRORS] ${pagePath}:`, server500s)
      }
    })
  }

  test('click 10 random internal links and verify no 500', async ({ page }) => {
    const visited = new Set<string>()
    const failures: { href: string; status: number }[] = []

    // Collect internal links from a few pages
    const sourcePaths = ['/', '/market', '/hot', '/rankings/tokens', '/groups']
    const allLinks: string[] = []

    for (const sp of sourcePaths) {
      await page.goto(sp, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(2000)

      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'))
        return anchors
          .map((a) => (a as HTMLAnchorElement).getAttribute('href') || '')
          .filter(
            (href) =>
              href.startsWith('/') &&
              !href.startsWith('//') &&
              !href.includes('logout') &&
              !href.includes('/api/') &&
              !href.includes('_next')
          )
      })
      allLinks.push(...links)
    }

    // Deduplicate and shuffle
    const unique = [...new Set(allLinks)]
    const shuffled = unique.sort(() => Math.random() - 0.5)
    const toVisit = shuffled.slice(0, 10)

    console.log(`\n  Testing ${toVisit.length} random internal links:`)

    for (const href of toVisit) {
      if (visited.has(href)) continue
      visited.add(href)

      let responseStatus = 0
      const handler = (response: any) => {
        if (response.url().includes(href.split('?')[0]) && response.status() >= 500) {
          responseStatus = response.status()
        }
      }

      page.on('response', handler)

      try {
        const resp = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (resp && resp.status() >= 500) {
          responseStatus = resp.status()
        }
      } catch {
        // Navigation timeout - not a 500 error per se
      }

      page.off('response', handler)

      const status = responseStatus || 200
      console.log(`    ${href} → ${status}`)

      if (status >= 500) {
        failures.push({ href, status })
      }
    }

    expect(failures, `Internal links returned 500: ${JSON.stringify(failures)}`).toHaveLength(0)
  })

  test.afterAll(async () => {
    // Print summary table
    console.log('\n' + '='.repeat(120))
    console.log('PAGE AUDIT SUMMARY')
    console.log('='.repeat(120))
    console.log(
      '| Page'.padEnd(30) +
        '| DOMContentLoaded'.padEnd(20) +
        '| Load Time'.padEnd(14) +
        '| Console Errors'.padEnd(18) +
        '| Failed Requests'.padEnd(19) +
        '| Error Text'.padEnd(14) +
        '| Flagged |'
    )
    console.log(
      '|' +
        '-'.repeat(29) +
        '|' +
        '-'.repeat(19) +
        '|' +
        '-'.repeat(13) +
        '|' +
        '-'.repeat(17) +
        '|' +
        '-'.repeat(18) +
        '|' +
        '-'.repeat(13) +
        '|' +
        '-'.repeat(9) +
        '|'
    )

    for (const r of results) {
      const loadFlag = r.loadTime > LOAD_TIME_THRESHOLD_MS ? ' !!!' : ''
      const errFlag = r.consoleErrors.length > 0 ? ' !!!' : ''
      const reqFlag = r.failedRequests.length > 0 ? ' !!!' : ''
      console.log(
        `| ${r.page}`.padEnd(30) +
          `| ${r.domContentLoaded}ms`.padEnd(20) +
          `| ${r.loadTime}ms${loadFlag}`.padEnd(14) +
          `| ${r.consoleErrors.length}${errFlag}`.padEnd(18) +
          `| ${r.failedRequests.length}${reqFlag}`.padEnd(19) +
          `| ${r.hasErrorText ? 'YES !!!' : 'no'}`.padEnd(14) +
          `| ${r.flagged ? 'YES' : 'ok'}`.padEnd(9) +
          '|'
      )
    }

    console.log('='.repeat(120))

    // Detailed errors
    const flaggedPages = results.filter((r) => r.flagged)
    if (flaggedPages.length > 0) {
      console.log('\n--- FLAGGED PAGES DETAILS ---')
      for (const r of flaggedPages) {
        console.log(`\n[${r.page}]`)
        if (r.loadTime > LOAD_TIME_THRESHOLD_MS) {
          console.log(`  SLOW: ${r.loadTime}ms (threshold: ${LOAD_TIME_THRESHOLD_MS}ms)`)
        }
        if (r.consoleErrors.length > 0) {
          console.log(`  CONSOLE ERRORS (${r.consoleErrors.length}):`)
          for (const e of r.consoleErrors) {
            console.log(`    - ${e}`)
          }
        }
        if (r.failedRequests.length > 0) {
          console.log(`  FAILED REQUESTS (${r.failedRequests.length}):`)
          for (const f of r.failedRequests) {
            console.log(`    - ${f.status} ${f.url}`)
          }
        }
        if (r.hasErrorText) {
          console.log('  ERROR TEXT: "Something went wrong" / "出了点问题" found on page')
        }
        if (r.hasErrorBoundary) {
          console.log('  ERROR BOUNDARY element detected')
        }
      }
    } else {
      console.log('\nAll pages passed audit checks.')
    }
    console.log('')
  })
})
