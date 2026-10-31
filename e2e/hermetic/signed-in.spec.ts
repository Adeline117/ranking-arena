import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const EMAIL = 'e2e@example.com'
const PASSWORD = 'e2e-password'

async function signIn(page: Page, password = PASSWORD) {
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'you@email.com' }).fill(EMAIL)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Login', exact: true }).last().click()
}

test.describe('signed-in path', () => {
  test('a wrong password shows an error and stays on login', async ({ page }) => {
    await signIn(page, 'wrong-password')
    await expect(page.locator('main')).toContainText(/incorrect|invalid/i)
    await expect(page).toHaveURL(/\/login/)
  })

  test('signing in leaves the login page and opens settings', async ({ page }) => {
    await signIn(page)
    await expect(page).not.toHaveURL(/\/login/)
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings/)
  })

  test('a watched trader survives a reload and can be removed', async ({ page }) => {
    await signIn(page)
    await expect(page).not.toHaveURL(/\/login/)
    await page.goto('/trader/e2e-shared?platform=binance_futures')

    await page
      .getByRole('button', { name: /add to watchlist/i })
      .first()
      .click()
    const remove = page.getByRole('button', { name: /remove from watchlist/i }).first()
    await expect(remove).toBeVisible()

    await page.reload()
    await expect(remove).toBeVisible()

    await page.goto('/saved?tab=traders')
    await expect(page.locator('main')).toContainText('E2E Shared Trader')

    await page.goto('/trader/e2e-shared?platform=binance_futures')
    await remove.click()
    await expect(page.getByRole('button', { name: /add to watchlist/i }).first()).toBeVisible()
  })
})
