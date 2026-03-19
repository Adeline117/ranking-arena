/**
 * E2E Subscription Flow Test
 *
 * Validates the pricing page, plan display, auth gating,
 * and pro feature gating across the app.
 */

import { test, expect } from '@playwright/test'

test.describe('Subscription Flow', () => {
  test('pricing page loads with 3 plans', async ({ page }) => {
    await page.goto('/pricing')
    await expect(page.locator('text=Monthly')).toBeVisible()
    await expect(page.locator('text=Yearly')).toBeVisible()
    await expect(page.locator('text=Lifetime')).toBeVisible()
  })

  test('plan card shows correct prices', async ({ page }) => {
    await page.goto('/pricing')
    await expect(page.locator('text=$4.99')).toBeVisible()
    await expect(page.locator('text=$29.99')).toBeVisible()
    await expect(page.locator('text=$49.99')).toBeVisible()
  })

  test('checkout button requires auth', async ({ page }) => {
    await page.goto('/pricing')
    // Click a plan button
    const buyButton = page.locator('button:has-text("Subscribe"), button:has-text("Get Started"), button:has-text("Upgrade")').first()
    if (await buyButton.isVisible()) {
      await buyButton.click()
      // Should redirect to login or show auth modal
      await expect(page.locator('text=Sign In, text=Log In, [data-testid="login-modal"]').first()).toBeVisible({ timeout: 5000 })
    }
  })

  test('pro features are gated', async ({ page }) => {
    await page.goto('/rankings/binance_futures')
    // Check if pro badge or upgrade CTA exists
    const proBadge = page.locator('text=Pro, text=Upgrade, text=PRO')
    await expect(proBadge.first()).toBeVisible({ timeout: 5000 })
  })
})
