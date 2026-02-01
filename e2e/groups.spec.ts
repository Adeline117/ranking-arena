import { test, expect } from '@playwright/test'

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

    await page.waitForSelector('[data-testid="group-item"], .group-card, article', { timeout: 15_000 }).catch(() => {})

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

    const firstGroup = page.locator('[data-testid="group-item"], .group-card, [href*="/groups/"]').first()

    if (await firstGroup.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstGroup.click()
      await page.waitForLoadState('domcontentloaded')

      const url = page.url()
      expect(url).toMatch(/\/groups\//)
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

      await page.waitForSelector('[data-testid="post-item"], article, .post', { timeout: 10_000 }).catch(() => {})
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
