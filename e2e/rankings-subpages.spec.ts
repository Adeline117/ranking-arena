import { expect, test, type Page, type Response } from '@playwright/test'
import { dismissOverlays } from './helpers'

function pageHealth(page: Page) {
  const pageErrors: string[] = []
  const hydrationErrors: string[] = []
  const failedAssets: string[] = []

  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /hydration|hydrating|did not match|minified react error #418/i.test(message.text())
    ) {
      hydrationErrors.push(message.text())
    }
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    let sameOrigin = false
    let responseUrl: URL
    try {
      responseUrl = new URL(response.url())
      sameOrigin = responseUrl.origin === new URL(page.url()).origin
    } catch {
      // Ignore responses observed before the first document URL is available.
      return
    }
    const isLocalVercelTelemetry =
      (responseUrl.hostname === 'localhost' || responseUrl.hostname === '127.0.0.1') &&
      (responseUrl.pathname === '/_vercel/insights/script.js' ||
        responseUrl.pathname === '/_vercel/speed-insights/script.js')
    if (isLocalVercelTelemetry) return
    const resourceType = response.request().resourceType()
    const isCriticalAsset =
      sameOrigin && (resourceType === 'script' || resourceType === 'stylesheet')
    const isExchangeLogo = sameOrigin && responseUrl.pathname.startsWith('/icons/exchanges/')
    if (isCriticalAsset || isExchangeLogo) {
      failedAssets.push(`${response.status()} ${responseUrl.pathname}`)
    }
  })

  return {
    assertHealthy: async () => {
      expect(pageErrors, 'uncaught page errors').toEqual([])
      expect(hydrationErrors, 'React hydration errors').toEqual([])
      expect(failedAssets, 'failed scripts, stylesheets, or exchange logos').toEqual([])
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow, 'root page must not overflow horizontally').toBeLessThanOrEqual(1)
    },
  }
}

async function expectSuccessfulNavigation(response: Response | null) {
  expect(response, 'navigation must produce a document response').not.toBeNull()
  expect(response!.status()).toBeLessThan(400)
}

test.describe('current rankings sub-pages', () => {
  test.describe.configure({ retries: 0 })
  test.use({ locale: 'de-DE', timezoneId: 'Pacific/Honolulu' })

  test('token rankings support navigation, filtering, sorting, and detail links', async ({
    page,
  }) => {
    const health = pageHealth(page)
    await expectSuccessfulNavigation(await page.goto('/rankings/tokens'))
    await dismissOverlays(page)

    await expect(page.locator('h1')).toBeVisible()
    const subnav = page.locator('nav').filter({
      has: page.locator('a[href="/rankings/tokens"][aria-current="page"]'),
    })
    await expect(subnav).toHaveCount(1)
    await expect(subnav.locator('a[href="/"]')).toBeVisible()

    const cards = page.locator('a.tk-card-link[href^="/rankings/tokens/"]')
    await expect(cards.first()).toBeVisible({ timeout: 30_000 })
    expect(await cards.count()).toBeGreaterThanOrEqual(12)
    const hasRealActivity = await cards.evaluateAll((links) =>
      links.some(
        (link) =>
          Number((link as HTMLElement).dataset.traderCount) > 0 ||
          Number((link as HTMLElement).dataset.tradeCount) > 0
      )
    )
    expect(hasRealActivity, 'token rankings must include non-zero upstream activity').toBe(true)

    const search = page.locator('.tk-search-input')
    await expect(search).toBeVisible()
    await expect(search).toHaveAttribute('aria-busy', 'false')
    await expect(search).toBeEnabled()
    await search.fill('NO_TOKEN_CAN_MATCH_THIS')
    await expect(cards).toHaveCount(0)
    await search.fill('BTC')

    const btcCard = page.locator('a.tk-card-link[href="/rankings/tokens/BTC"]')
    await expect(btcCard).toHaveCount(1)
    await expect(btcCard).toBeVisible()

    await search.clear()
    const sortGroup = page.locator('[role="group"]').filter({ has: page.locator('.tk-sort-btn') })
    const sortButtons = sortGroup.locator('.tk-sort-btn')
    await expect(sortButtons).toHaveCount(3)
    const sortMetrics = ['traderCount', 'tradeCount', 'totalPnl'] as const
    for (const [index, metric] of sortMetrics.entries()) {
      const button = sortButtons.nth(index)
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
      const values = await cards.evaluateAll(
        (links, dataKey) =>
          links.map((link) => Number((link as HTMLElement).dataset[dataKey as string])),
        metric
      )
      expect(values, `${metric} cards must be sorted descending`).toEqual(
        [...values].sort((a, b) => b - a)
      )
    }

    await health.assertHealthy()
    await btcCard.click()
    await expect(page).toHaveURL(/\/rankings\/tokens\/BTC(?:[/?#]|$)/)
    await expect(page.locator('h1')).toContainText('BTC')
    await health.assertHealthy()
  })

  test('exchange rankings expose every timeframe, sortable rows, and working detail links', async ({
    page,
  }) => {
    const health = pageHealth(page)
    await expectSuccessfulNavigation(await page.goto('/rankings/exchanges'))
    await dismissOverlays(page)

    await expect(page.locator('h1')).toBeVisible()
    const tablist = page.getByRole('tablist')
    await expect(tablist).toBeVisible()

    const exchangeLinks = page.locator('table tbody a[href^="/exchange/"]')
    for (const timeframe of ['7D', '30D', '90D']) {
      const tab = tablist.getByRole('tab', { name: timeframe, exact: true })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(exchangeLinks.first()).toBeVisible()
    }

    const firstSort = page.locator('table thead button').first()
    await expect(firstSort).toBeVisible()
    const sortHeader = firstSort.locator('xpath=..')
    const beforeSort = await sortHeader.getAttribute('aria-sort')
    await firstSort.click()
    await expect(sortHeader).not.toHaveAttribute('aria-sort', beforeSort ?? 'none')
    await expect(sortHeader).toHaveAttribute('aria-sort', 'ascending')
    const exchangeNamesAreSorted = await exchangeLinks.evaluateAll((links) => {
      const names = links.map((link) => link.textContent?.trim().toLowerCase() ?? '')
      return names.every((name, index) => index === 0 || names[index - 1].localeCompare(name) <= 0)
    })
    expect(exchangeNamesAreSorted, 'exchange rows must be sorted by name').toBe(true)

    const firstLogo = page.locator('table tbody img').first()
    await expect(firstLogo).toBeVisible()
    expect(
      await firstLogo.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0
      ),
      'first exchange logo must decode to a non-empty image'
    ).toBe(true)

    const href = await exchangeLinks.first().getAttribute('href')
    expect(href).toMatch(/^\/exchange\/[a-z0-9-]+$/)
    await health.assertHealthy()
    await exchangeLinks.first().click()
    await expect(page).toHaveURL(
      new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?#]|$)`)
    )
    await expect(page.locator('h1')).toBeVisible()
    await health.assertHealthy()
  })

  test('weekly rankings render real traders and an operative sortable table', async ({ page }) => {
    const health = pageHealth(page)
    await expectSuccessfulNavigation(await page.goto('/rankings/weekly'))
    await dismissOverlays(page)

    await expect(page.locator('h1')).toBeVisible()
    const traderLinks = page.locator('table tbody a[href^="/trader/"]')
    await expect(traderLinks.first()).toBeVisible()

    const sortButton = page.locator('table thead button').first()
    await expect(sortButton).toBeVisible()
    const sortHeader = sortButton.locator('xpath=..')
    const beforeSort = await sortHeader.getAttribute('aria-sort')
    await sortButton.click()
    await expect(sortHeader).not.toHaveAttribute('aria-sort', beforeSort ?? 'none')
    await expect(sortHeader).toHaveAttribute('aria-sort', 'ascending')
    const traderNamesAreSorted = await traderLinks.evaluateAll((links) => {
      const names = links.map(
        (link) => (link as HTMLElement).dataset.traderName?.toLowerCase() ?? ''
      )
      return names.every((name, index) => index === 0 || names[index - 1].localeCompare(name) <= 0)
    })
    expect(traderNamesAreSorted, 'weekly rows must be sorted by trader name').toBe(true)

    const visibleText = await page.locator('main').innerText()
    expect(visibleText).not.toMatch(/\b(?:NaN|undefined)\b/)
    await health.assertHealthy()
  })
})
