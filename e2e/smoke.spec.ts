/**
 * E2E Smoke Test — Core User Flow
 *
 * Simulates a real user journey through the core path:
 * Homepage → Rankings → Trader Detail → Period Switch → Search → Login
 *
 * Records timing, console errors, and failed network requests per step.
 */

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'

interface StepResult {
  step: string
  durationMs: number
  consoleErrors: string[]
  failedRequests: string[]
  passed: boolean
}

const results: StepResult[] = []

function collectErrors(page: Page) {
  const consoleErrors: string[] = []
  const failedRequests: string[] = []

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
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

async function runStep(
  page: Page,
  stepName: string,
  fn: () => Promise<void>
): Promise<StepResult> {
  const { consoleErrors, failedRequests, cleanup } = collectErrors(page)
  const start = Date.now()
  let passed = true

  try {
    await fn()
  } catch {
    passed = false
  } finally {
    cleanup()
  }

  const result: StepResult = {
    step: stepName,
    durationMs: Date.now() - start,
    consoleErrors: [...consoleErrors],
    failedRequests: [...failedRequests],
    passed,
  }
  results.push(result)
  return result
}

test.describe('Smoke Test — Core User Flow', () => {
  test('complete user journey', async ({ page }) => {
    // Step 1: Homepage loads
    const homeResult = await runStep(page, 'Homepage Load', async () => {
      await page.goto('/')
      await page.waitForLoadState('domcontentloaded')
      await expect(page).toHaveTitle(/Arena/)
      await expect(page.getByRole('navigation').first()).toBeVisible()
    })
    expect(homeResult.passed).toBe(true)

    // Step 2: Rankings visible
    const rankingResult = await runStep(page, 'Rankings Visible', async () => {
      // Try both class-based and semantic selectors for the ranking section
      const rankingSection = page.locator('.home-ranking-section, section:has(a[href*="/trader/"]), [data-testid="ranking-section"]').first()
      await expect(rankingSection).toBeVisible({ timeout: 30_000 })
      // Verify at least one trader link exists
      const traderLinks = page.locator('a[href*="/trader/"]')
      await traderLinks.first().waitFor({ state: 'visible', timeout: 15_000 })
      expect(await traderLinks.count()).toBeGreaterThan(0)
    })
    expect(rankingResult.passed).toBe(true)

    // Step 3: Navigate to trader detail
    let traderHref = ''
    const traderDetailResult = await runStep(page, 'Trader Detail', async () => {
      const traderLinks = page.locator('a[href*="/trader/"]')
      const firstLink = traderLinks.first()
      traderHref = (await firstLink.getAttribute('href')) || ''
      await firstLink.click()
      await page.waitForURL(`**${traderHref}`, { timeout: 15_000 })
      await page.waitForLoadState('domcontentloaded')
      // Page should render content (not blank)
      const bodyText = await page.locator('body').textContent()
      expect((bodyText || '').trim().length).toBeGreaterThan(50)
    })
    expect(traderDetailResult.passed).toBe(true)

    // Step 4: Period switch on trader page (if tabs exist)
    await runStep(page, 'Period Switch', async () => {
      const tabs = page.locator('button, [role="tab"]').filter({
        hasText: /Overview|概览|Stats|统计|Portfolio|持仓|Chart|图表/i,
      })
      if ((await tabs.count()) > 1) {
        await tabs.nth(1).click()
        await page.waitForTimeout(500)
        await tabs.first().click()
        await page.waitForTimeout(500)
      }
    })

    // Step 5: Search
    const searchResult = await runStep(page, 'Search', async () => {
      await page.goto('/search')
      await page.waitForLoadState('domcontentloaded')
      const searchInput = page.getByPlaceholder(/搜索|Search/i)
      if ((await searchInput.count()) > 0) {
        await searchInput.first().fill('BTC')
        // Wait for search results to appear
        await page.waitForTimeout(1500)
      }
      const bodyText = await page.locator('body').textContent()
      expect((bodyText || '').trim().length).toBeGreaterThan(20)
    })
    expect(searchResult.passed).toBe(true)

    // Step 6: Login page accessible
    const loginResult = await runStep(page, 'Login Page', async () => {
      await page.goto('/login')
      await page.waitForLoadState('domcontentloaded')
      const bodyText = await page.locator('body').textContent()
      expect((bodyText || '').trim().length).toBeGreaterThan(20)
    })
    expect(loginResult.passed).toBe(true)

    // Summary
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0)
    const allPassed = results.every((r) => r.passed)
    const totalConsoleErrors = results.reduce((sum, r) => sum + r.consoleErrors.length, 0)
    const totalFailedRequests = results.reduce((sum, r) => sum + r.failedRequests.length, 0)

    console.log('\n=== Smoke Test Summary ===')
    for (const r of results) {
      const status = r.passed ? 'PASS' : 'FAIL'
      console.log(
        `  [${status}] ${r.step}: ${r.durationMs}ms` +
          (r.consoleErrors.length ? ` (${r.consoleErrors.length} console errors)` : '') +
          (r.failedRequests.length ? ` (${r.failedRequests.length} failed requests)` : '')
      )
    }
    console.log(`  Total: ${totalDuration}ms | Errors: ${totalConsoleErrors} | Failed Requests: ${totalFailedRequests}`)
    console.log(`  Result: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`)

    expect(allPassed).toBe(true)
  })
})
