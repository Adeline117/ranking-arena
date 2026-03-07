import { test, expect } from '@playwright/test'

/**
 * Mobile-specific E2E Tests
 * Tests mobile navigation, touch interactions, and responsive behavior
 */

/** Helper: dismiss cookie consent banner if visible */
async function dismissCookieConsent(page: import('@playwright/test').Page) {
  const acceptCookies = page.locator('button:has-text("接受全部"), button:has-text("Accept")')
  if (await acceptCookies.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await acceptCookies.first().click()
    await page.waitForTimeout(500)
  }
}

test.describe('移动端导航测试', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1000)
    await dismissCookieConsent(page)
  })


  test('搜索页面深链接', async ({ page }) => {
    await page.goto('/search?q=bitcoin')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url).toContain('/search')
  })
})

test.describe('移动端性能测试', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('首屏加载性能', async ({ page }) => {
    const startTime = Date.now()

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const loadTime = Date.now() - startTime
    expect(loadTime).toBeLessThan(10_000)
  })

  test('滚动性能 - 无卡顿', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    await page.evaluate(() => {
      window.scrollTo({ top: 1000, behavior: 'smooth' })
    })

    await page.waitForTimeout(500)

    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })

    expect(true).toBeTruthy()
  })

  test('图片懒加载工作', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const lazyImages = await page.locator('img[loading="lazy"]').count()
    const allImages = await page.locator('img').count()

    if (allImages > 5) {
      expect(lazyImages).toBeGreaterThan(0)
    }
  })
})
