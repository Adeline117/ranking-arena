import { test, expect } from './fixtures'

test.describe('core path', () => {
  test('homepage lists ranked traders in rank order', async ({ page }) => {
    await page.goto('/')
    const links = page.locator('#homepage-interactive a[href*="/trader/"]:visible')
    await expect(links.first()).toContainText('E2E 90D Trader 1')
    await expect(links.nth(1)).toContainText('E2E 90D Trader 2')
  })

  test('switching period replaces the traders with that period', async ({ page }) => {
    await page.goto('/')
    const links = page.locator('#homepage-interactive a[href*="/trader/"]:visible')
    await expect(links.first()).toContainText('E2E 90D')
    await page.getByRole('button', { name: 'Show 7D rankings' }).click()
    await expect(links.first()).toContainText('E2E 7D Trader 1')
    await expect(links.filter({ hasText: 'E2E 90D' })).toHaveCount(0)
  })

  test('opening a trader shows that trader', async ({ page }) => {
    await page.goto('/')
    const first = page.locator('#homepage-interactive a[href*="/trader/"]:visible').first()
    await expect(first).toContainText('E2E 90D Trader 1')
    await first.click()
    await expect(page).toHaveURL(/\/trader\//)
    await expect(page.getByRole('heading', { name: /E2E 90D Trader 1/ })).toBeVisible()
  })

  test("switching period on a trader shows that period's numbers", async ({ page }) => {
    await page.goto('/trader/e2e-shared?platform=binance_futures')
    await expect(page.getByRole('heading', { name: 'E2E Shared Trader' })).toBeVisible()
    const roi = page.getByRole('tabpanel', { name: 'Overview' })
    await expect(roi.getByRole('img', { name: 'ROI +333.0%' })).toBeVisible()
    await page.getByRole('button', { name: '7D period' }).click()
    await expect(roi.getByRole('img', { name: 'ROI +111.0%' })).toBeVisible()
    await page.getByRole('button', { name: '30D period' }).click()
    await expect(roi.getByRole('img', { name: 'ROI +222.0%' })).toBeVisible()
  })

  test('an exchange ranking only lists that exchange', async ({ page }) => {
    await page.goto('/rankings/binance_futures')
    const links = page.locator('a[href*="/trader/"]:visible')
    await expect(links.first()).toContainText('E2E 90D Trader 1')
    await expect(links.nth(1)).toContainText('E2E 90D Trader 3')
    // Even ranks are hyperliquid in the fixture.
    await expect(links.filter({ hasText: /E2E 90D Trader 2$/ })).toHaveCount(0)
  })

  test('search finds a trader by name', async ({ page, isMobile }) => {
    // Start from a page with no ranking, so only the search can produce this result.
    await page.goto('/pricing')
    await expect(page.locator('a[href*="/trader/"]:visible')).toHaveCount(0)
    if (isMobile) await page.getByRole('button', { name: 'Search' }).click()
    await page
      .getByRole(isMobile ? 'textbox' : 'combobox', { name: /Search traders/ })
      .fill('E2E 90D Trader 1')
    await expect(page.getByRole('listbox', { name: 'Search results' })).toContainText(
      'E2E 90D Trader 1'
    )
  })
})

test.describe('account path', () => {
  test('login page offers a way to sign in', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('input[type="email"]:visible').first()).toBeVisible()
  })

  test('a signed-out visitor cannot see settings', async ({ page }) => {
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/login/)
  })

  test('pricing shows a Pro plan', async ({ page }) => {
    await page.goto('/pricing')
    await expect(page.locator('body')).toContainText(/Pro/)
  })

  test('without Stripe configured, checkout is disabled rather than broken', async ({ page }) => {
    await page.goto('/pricing')
    const buttons = page.getByRole('button', { name: 'Payment system coming soon' })
    await expect(buttons.first()).toBeVisible()
    await expect(buttons.first()).toBeDisabled()
  })

  test('the checkout API refuses to start without Stripe configured', async ({ request }) => {
    const response = await request.post('/api/stripe/create-checkout', {
      data: { plan: 'monthly' },
    })
    expect(response.status()).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('checkout.stripe.com')
  })
})
