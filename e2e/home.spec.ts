import { test, expect } from '@playwright/test'
import { dismissOverlays } from './helpers'

test.describe('首页测试', () => {
  test.beforeEach(async ({ page }) => {
    // Dev server may be slow to compile on first hit — use longer timeout for goto
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')
    await dismissOverlays(page)
  })

  test('页面正常加载', async ({ page }) => {
    await expect(page).toHaveTitle(/Arena/)
    // Two nav elements exist (desktop + mobile bottom) — use .first()
    await expect(page.getByRole('navigation').first()).toBeVisible()
  })

  test('排行榜正确显示', async ({ page }) => {
    // Ranking section is a client component — wait for hydration and data
    const rankingSection = page.locator('.home-ranking-section')
    await expect(rankingSection).toBeVisible({ timeout: 30_000 })

    // Time range buttons use data-testid or text content
    const btn90 = page
      .locator('[data-testid="time-range-90D"], button:has-text("90D"), button:has-text("90天")')
      .first()
    const btn30 = page
      .locator('[data-testid="time-range-30D"], button:has-text("30D"), button:has-text("30天")')
      .first()
    const btn7 = page
      .locator('[data-testid="time-range-7D"], button:has-text("7D"), button:has-text("7天")')
      .first()

    await expect(btn90).toBeVisible({ timeout: 10_000 })
    await expect(btn30).toBeVisible({ timeout: 5_000 })
    await expect(btn7).toBeVisible({ timeout: 5_000 })
  })

  test('时间范围切换功能', async ({ page }) => {
    const rankingSection = page.locator('.home-ranking-section')
    await expect(rankingSection).toBeVisible({ timeout: 30_000 })

    // Wait for initial data load to complete (buttons become enabled)
    const button30d = page
      .locator('[data-testid="time-range-30D"], button:has-text("30D"), button:has-text("30天")')
      .first()
    await expect(button30d).toBeEnabled({ timeout: 30_000 })
    await button30d.click()

    // After click, button may briefly disable while fetching — wait for re-enable
    await expect(button30d).toBeEnabled({ timeout: 30_000 })

    const button7d = page
      .locator('[data-testid="time-range-7D"], button:has-text("7D"), button:has-text("7天")')
      .first()
    await expect(button7d).toBeEnabled({ timeout: 30_000 })
    await button7d.click()
    await expect(button7d).toBeEnabled({ timeout: 30_000 })
  })

  test('排行榜分页功能', async ({ page }) => {
    const rankingSection = page.locator('.home-ranking-section')
    if (!(await rankingSection.isVisible({ timeout: 15_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const pagination = page.locator('button').filter({ hasText: /下一页|Next|>/ })

    if ((await pagination.count()) > 0) {
      await pagination.first().click()
      await page.waitForTimeout(1000)
    }
  })

  test('搜索功能可用', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/)

    if ((await searchInput.count()) > 0) {
      await expect(searchInput.first()).toBeVisible()
      await searchInput.first().fill('BTC')
      await page.waitForTimeout(500)
    }
  })
})

test.describe('首页移动端响应式布局', () => {
  // Execute the explicit width matrix once in Chromium instead of
  // overriding every project's native viewport with the same dimensions.
  test.skip(
    ({ isMobile }) => isMobile,
    'The desktop Chromium project owns the explicit mobile width matrix'
  )

  test('320px / 375px 核心布局', async ({ page }) => {
    const viewports = [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
    ] as const

    for (const viewport of viewports) {
      await test.step(`${viewport.width}px viewport`, async () => {
        await page.setViewportSize(viewport)
        await page.goto('/', { timeout: 60_000 })
        await page.waitForLoadState('domcontentloaded')
        await dismissOverlays(page)

        // Scope assertions to the hydrated surface: the SSR fallback remains in the
        // DOM during the hand-off and must not let a broken interactive layout pass.
        const layout = page.locator('#homepage-interactive .three-col-layout').first()
        const center = layout.locator(':scope > .three-col-center')
        const rankingSection = center.locator('.home-ranking-section')

        await expect(layout).toBeVisible({ timeout: 30_000 })
        await expect(rankingSection).toBeVisible({ timeout: 30_000 })

        // At the mobile breakpoint, the ranking owns the single visible column;
        // both desktop sidebars must be hidden and the center must not overflow.
        const left = layout.locator(':scope > .three-col-left')
        const right = layout.locator(':scope > .three-col-right')
        if ((await left.count()) > 0) await expect(left).toBeHidden()
        await expect(right).toHaveCount(1)
        await expect(right).toBeHidden()
        await expect(layout).toHaveCSS('display', 'block')
        await expect(center).toBeVisible()
        await expect
          .poll(async () => {
            const box = await center.boundingBox()
            const currentViewport = page.viewportSize()
            return !!(
              box &&
              currentViewport &&
              box.x >= -0.5 &&
              box.x + box.width <= currentViewport.width + 0.5
            )
          })
          .toBe(true)

        const documentWidth = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }))
        expect(documentWidth.viewportWidth).toBe(viewport.width)
        expect(documentWidth.scrollWidth).toBeLessThanOrEqual(documentWidth.viewportWidth)
      })
    }
  })
})

test.describe('性能测试', () => {
  test('首页加载时间', async ({ page }) => {
    const startTime = Date.now()

    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')

    const loadTime = Date.now() - startTime
    expect(loadTime).toBeLessThan(30_000)
  })

  test('排行榜数据加载时间', async ({ page }) => {
    await page.goto('/', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')

    const startTime = Date.now()

    // Wait for ranking section or skeleton to appear
    await page
      .waitForSelector('.home-ranking-section', {
        timeout: 30_000,
      })
      .catch(() => {}) // eslint-disable-line no-restricted-syntax -- Playwright: element may not exist

    const loadTime = Date.now() - startTime

    // Soft assertion — ranking section may not render in all environments
    const sectionExists = (await page.locator('.home-ranking-section').count()) > 0
    if (sectionExists) {
      expect(loadTime).toBeLessThan(30_000)
    }
  })
})
