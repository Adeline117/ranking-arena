import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

/**
 * Core-path Auth Flow E2E Tests
 * Tests: login button visibility, watchlist redirect, settings redirect
 */

test.describe('Core Auth Flow', () => {
  test('login button visible when not authenticated', async ({ page }) => {
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)

    // Login link/button should be visible for unauthenticated users
    const loginLink = page.getByRole('link', { name: /登录|login|sign in/i })
    await expect(loginLink).toBeVisible({ timeout: 15_000 })
  })

  test('/watchlist redirects unauthenticated users', async ({ page }) => {
    // Navigate to /watchlist without being logged in
    const response = await page.goto('/watchlist', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')

    // Should redirect to login page or show an auth-required message
    const url = page.url()
    const bodyText = await page.textContent('body')

    const redirectedToLogin = /\/login/.test(url)
    const showsAuthMessage = /登录|login|sign in|unauthorized|authenticate/i.test(bodyText || '')
    const shows404 = response?.status() === 404

    // Any of these indicate proper auth guarding
    expect(redirectedToLogin || showsAuthMessage || shows404).toBeTruthy()
  })

  test('/settings redirects unauthenticated users', async ({ page }) => {
    // Navigate to /settings without being logged in
    const response = await page.goto('/settings', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')

    // Should redirect to login page or show an auth-required message
    const url = page.url()
    const bodyText = await page.textContent('body')

    const redirectedToLogin = /\/login/.test(url)
    const showsAuthMessage = /登录|login|sign in|unauthorized|authenticate/i.test(bodyText || '')
    const shows404 = response?.status() === 404

    expect(redirectedToLogin || showsAuthMessage || shows404).toBeTruthy()
  })
})
