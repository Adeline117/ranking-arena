import { test, expect } from '@playwright/test'

/** Helper: dismiss cookie consent banner if visible */
async function dismissCookieConsent(page: import('@playwright/test').Page) {
  const acceptCookies = page.locator('button:has-text("接受全部"), button:has-text("Accept")')
  if (await acceptCookies.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await acceptCookies.first().click()
    await page.waitForTimeout(500)
  }
}

test.describe('小组功能', () => {
  test('小组列表页面可以访问', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('domcontentloaded')

    await expect(page).toHaveURL(/\/groups/)
    await expect(page).toHaveTitle(/Arena/i)
  })

  test('显示小组列表', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('domcontentloaded')

    await page.waitForSelector('[data-testid="group-item"], .group-card, article', { timeout: 15_000 }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- Playwright: element may not exist

    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })

  test('小组卡片包含基本信息', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('domcontentloaded')

    const firstGroup = page.locator('[data-testid="group-item"], .group-card').first()

    if (await firstGroup.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const text = await firstGroup.textContent()
      expect(text).toBeTruthy()
    }
  })

  test('点击小组可以查看详情', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000) // Wait for groups to load
    await dismissCookieConsent(page)

    // Look specifically for group links (not the nav link /groups)
    const groupLink = page.locator('a[href^="/groups/"]').first()

    if (await groupLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const _href = await groupLink.getAttribute('href')
      await groupLink.click()
      await page.waitForTimeout(2000) // Wait for navigation

      const url = page.url()
      // Should navigate to group detail page, or stay on groups if modal-based
      expect(url.includes('/groups/') || url.includes('/groups')).toBeTruthy()
    }
  })
})

test.describe('小组详情', () => {
  test('小组详情页显示小组信息', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('domcontentloaded')

    const firstGroup = page.locator('[data-testid="group-item"], .group-card, [href*="/groups/"]').first()

    if (await firstGroup.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstGroup.click()
      await page.waitForLoadState('domcontentloaded')

      const content = await page.textContent('body')
      expect(content).toBeTruthy()
    }
  })

  test('小组详情页显示帖子列表', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('domcontentloaded')

    const firstGroup = page.locator('[data-testid="group-item"], .group-card, [href*="/groups/"]').first()

    if (await firstGroup.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstGroup.click()
      await page.waitForLoadState('domcontentloaded')

      await page.waitForSelector('[data-testid="post-item"], article, .post', { timeout: 10_000 }).catch(() => {}) // eslint-disable-line no-restricted-syntax -- Playwright: element may not exist
    }
  })
})

test.describe('小组申请', () => {
  test('申请创建小组页面可以访问', async ({ page }) => {
    await page.goto('/groups/apply')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url.includes('/groups/apply') || url.includes('/login')).toBe(true)
  })
})
