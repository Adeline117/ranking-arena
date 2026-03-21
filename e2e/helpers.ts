import type { Page } from '@playwright/test'

/** Dismiss cookie consent banner if visible */
export async function dismissCookieConsent(page: Page) {
  const acceptCookies = page.locator('button:has-text("接受全部"), button:has-text("Accept")')
  if (await acceptCookies.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await acceptCookies.first().click()
  }
}

/** Dismiss WelcomeModal onboarding overlay if visible */
export async function dismissWelcomeModal(page: Page) {
  const closeBtn = page.locator('button[aria-label="Close"]')
  if (await closeBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.first().click()
  }
}

/** Dismiss all overlays (cookie consent + welcome modal) */
export async function dismissOverlays(page: Page) {
  await dismissWelcomeModal(page)
  await dismissCookieConsent(page)
}
