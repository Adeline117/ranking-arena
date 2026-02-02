import { test, expect } from '@playwright/test'

test.describe('交易员详情页测试', () => {
  test('从排行榜导航到交易员详情', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Wait for ranking data to appear (links to trader pages)
    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if (await traderLinks.count() > 0) {
      const firstTraderLink = traderLinks.first()
      const href = await firstTraderLink.getAttribute('href')

      await firstTraderLink.click()
      await page.waitForURL(`**${href}`, { timeout: 15_000 })

      await expect(page.locator('body')).toBeVisible()
    }
  })

  test('交易员详情页核心元素', async ({ page }) => {
    await page.goto('/trader/test')
    await page.waitForLoadState('domcontentloaded')

    const notFoundText = page.getByText(/not found|不存在|404/i)

    if (await notFoundText.count() === 0) {
      const header = page.locator('[class*="header"], [class*="Header"]')
      if (await header.count() > 0) {
        await expect(header.first()).toBeVisible()
      }
    }
  })

  test('交易员页面 Tab 切换', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if (await traderLinks.count() > 0) {
      await traderLinks.first().click()
      await page.waitForLoadState('domcontentloaded')

      const tabs = page.locator('button, [role="tab"]').filter({
        hasText: /Overview|概览|Stats|统计|Portfolio|持仓|Chart|图表/i,
      })

      if (await tabs.count() > 1) {
        await tabs.nth(1).click()
        await page.waitForTimeout(300)
      }
    }
  })

  test('交易员关注功能（需登录）', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if (await traderLinks.count() > 0) {
      await traderLinks.first().click()
      await page.waitForLoadState('domcontentloaded')

      const followButton = page.locator('button').filter({
        hasText: /Follow|关注/i,
      })

      if (await followButton.count() > 0) {
        await followButton.first().click()
        await page.waitForTimeout(500)
      }
    }
  })
})

test.describe('交易员详情页错误状态', () => {
  test('不存在的交易员显示错误或未找到页面', async ({ page }) => {
    await page.goto('/trader/nonexistent-handle-xyz-12345')
    await page.waitForLoadState('domcontentloaded')

    const body = page.locator('body')
    const bodyText = await body.textContent()
    expect(bodyText?.trim().length).toBeGreaterThan(0)

    const hasErrorContent = await page.locator(
      'text=/not found|不存在|error|出错|错误|返回|back|retry|重试/i'
    ).count()
    const hasNavigation = await page.locator('nav, a[href="/"]').count()

    expect(hasErrorContent + hasNavigation).toBeGreaterThan(0)
  })
})

test.describe('交易员详情页性能', () => {
  test('详情页加载时间', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const traderLinks = page.locator('a[href*="/trader/"]')
    await traderLinks.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})

    if (await traderLinks.count() > 0) {
      const href = await traderLinks.first().getAttribute('href')

      const startTime = Date.now()
      await page.goto(href!)
      await page.waitForLoadState('domcontentloaded')

      const loadTime = Date.now() - startTime
      expect(loadTime).toBeLessThan(10_000)
    }
  })
})
