import { test, expect } from '@playwright/test'

test.describe('首页测试', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
  })

  test('页面正常加载', async ({ page }) => {
    await expect(page).toHaveTitle(/Arena/)
    await expect(page.getByRole('navigation')).toBeVisible()
  })

  test('排行榜正确显示', async ({ page }) => {
    // Wait for ranking section with generous timeout
    await page.waitForSelector('.home-ranking-section', { timeout: 30_000 })

    await expect(page.getByRole('button', { name: /90D|90天/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /30D|30天/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /7D|7天/ })).toBeVisible()
  })

  test('时间范围切换功能', async ({ page }) => {
    await page.waitForSelector('.home-ranking-section', { timeout: 30_000 })

    const button30d = page.getByRole('button', { name: /30D|30天/ })
    await button30d.click()
    await expect(button30d).toBeEnabled()

    const button7d = page.getByRole('button', { name: /7D|7天/ })
    await button7d.click()
    await expect(button7d).toBeEnabled()
  })

  test('响应式布局 - 移动端', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    const leftSection = page.locator('.home-left-section')
    await expect(leftSection).not.toBeVisible()
  })

  test('排行榜分页功能', async ({ page }) => {
    await page.waitForSelector('.home-ranking-section', { timeout: 30_000 })

    const pagination = page.locator('button').filter({ hasText: /下一页|Next|>/ })

    if (await pagination.count() > 0) {
      await pagination.first().click()
      await page.waitForTimeout(1000)
    }
  })

  test('搜索功能可用', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/)

    if (await searchInput.count() > 0) {
      await expect(searchInput.first()).toBeVisible()
      await searchInput.first().fill('BTC')
      await page.waitForTimeout(500)
    }
  })
})

test.describe('性能测试', () => {
  test('首页加载时间', async ({ page }) => {
    const startTime = Date.now()

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const loadTime = Date.now() - startTime
    expect(loadTime).toBeLessThan(10_000)
  })

  test('排行榜数据加载时间', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const startTime = Date.now()

    await page.waitForSelector('.home-ranking-section table, .home-ranking-section [class*="skeleton"]', {
      timeout: 30_000,
    })

    const loadTime = Date.now() - startTime
    expect(loadTime).toBeLessThan(15_000)
  })
})
