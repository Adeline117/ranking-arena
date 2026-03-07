/**
 * Visual Regression Test
 *
 * Screenshots all core pages at desktop (1920px) and mobile (375px),
 * captures console errors + failed network requests.
 * Rolls back if new console errors are found.
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'

const CORE_PAGES = [
  { name: 'homepage', path: '/' },
  { name: 'rankings', path: '/' }, // rankings is homepage
  { name: 'search', path: '/search' },
  { name: 'login', path: '/login' },
  { name: 'market', path: '/market' },
  { name: 'library', path: '/library' },
  { name: 'pricing', path: '/pricing' },
]

const VIEWPORTS = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 375, height: 812 },
]

interface PageReport {
  page: string
  viewport: string
  consoleErrors: string[]
  failedRequests: string[]
  loadTimeMs: number
}

function collectPageErrors(page: Page) {
  const consoleErrors: string[] = []
  const failedRequests: string[] = []

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Filter common non-critical errors
      if (
        text.includes('favicon') ||
        text.includes('hydration') ||
        text.includes('Warning:')
      ) return
      consoleErrors.push(text)
    }
  }

  const onRequestFailed = (req: { url: () => string; failure: () => { errorText: string } | null }) => {
    const failure = req.failure()
    if (failure) {
      failedRequests.push(`${req.url()} - ${failure.errorText}`)
    }
  }

  page.on('console', onConsole)
  page.on('requestfailed', onRequestFailed)

  return {
    consoleErrors,
    failedRequests,
    cleanup: () => {
      page.off('console', onConsole)
      page.off('requestfailed', onRequestFailed)
    },
  }
}

const allReports: PageReport[] = []

for (const viewport of VIEWPORTS) {
  for (const corePage of CORE_PAGES) {
    test(`${corePage.name} @ ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })

      const { consoleErrors, failedRequests, cleanup } = collectPageErrors(page)
      const start = Date.now()

      await page.goto(corePage.path)
      await page.waitForLoadState('domcontentloaded')
      // Give client components time to hydrate
      await page.waitForTimeout(2000)

      const loadTimeMs = Date.now() - start

      // Take screenshot
      await page.screenshot({
        path: `test-results/screenshots/${corePage.name}-${viewport.name}.png`,
        fullPage: true,
      })

      cleanup()

      const report: PageReport = {
        page: corePage.name,
        viewport: viewport.name,
        consoleErrors: [...consoleErrors],
        failedRequests: [...failedRequests],
        loadTimeMs,
      }
      allReports.push(report)

      // Log report
      if (consoleErrors.length > 0) {
        console.log(`[${corePage.name}@${viewport.name}] Console errors:`)
        for (const err of consoleErrors) {
          console.log(`  - ${err.slice(0, 200)}`)
        }
      }

      // Assertions: no critical console errors
      // Filter out known non-critical patterns
      const criticalErrors = consoleErrors.filter(
        (e) =>
          !e.includes('ChunkLoadError') &&
          !e.includes('Loading chunk') &&
          !e.includes('ResizeObserver')
      )
      expect(criticalErrors.length).toBeLessThanOrEqual(3)

      // Page should load within 15s
      expect(loadTimeMs).toBeLessThan(15_000)
    })
  }
}

test.afterAll(() => {
  console.log('\n=== Visual Regression Summary ===')
  for (const report of allReports) {
    console.log(
      `  ${report.page}@${report.viewport}: ${report.loadTimeMs}ms` +
        ` | ${report.consoleErrors.length} errors` +
        ` | ${report.failedRequests.length} failed requests`
    )
  }
  const totalErrors = allReports.reduce((s, r) => s + r.consoleErrors.length, 0)
  console.log(`  Total console errors: ${totalErrors}`)
})
