import type { Locator, Page } from '@playwright/test'

/** Dismiss cookie consent banner if visible */
export async function dismissCookieConsent(page: Page) {
  const acceptCookies = page.locator('button:has-text("接受全部"), button:has-text("Accept")')
  if (
    await acceptCookies
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false)
  ) {
    await acceptCookies.first().click()
  }
}

/** Dismiss WelcomeModal onboarding overlay if visible */
export async function dismissWelcomeModal(page: Page) {
  const closeBtn = page.locator('button[aria-label="Close"]')
  if (
    await closeBtn
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false)
  ) {
    await closeBtn.first().click()
  }
}

/** Dismiss all overlays (cookie consent + welcome modal) */
export async function dismissOverlays(page: Page) {
  await dismissWelcomeModal(page)
  await dismissCookieConsent(page)
}

/** Return the responsive search input, opening the mobile dialog when needed. */
export async function getVisibleSearchInput(page: Page): Promise<Locator> {
  let input = page
    .getByPlaceholder(/搜索|Search/i)
    .filter({ visible: true })
    .first()
  if (await input.isVisible({ timeout: 2000 }).catch(() => false)) return input

  const trigger = page
    .locator('button[aria-label="Search"]:visible, button[aria-label="搜索"]:visible')
    .first()
  await trigger.click({ timeout: 10_000 })

  input = page
    .getByPlaceholder(/搜索|Search/i)
    .filter({ visible: true })
    .first()
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  return input
}
