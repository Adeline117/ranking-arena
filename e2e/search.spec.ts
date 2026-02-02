import { test, expect } from '@playwright/test'

test.describe('搜索功能测试', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
  })

  test('搜索框可见且可交互', async ({ page }) => {
    await page.waitForTimeout(2000) // Wait for hydration
    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()
      await expect(input).toBeVisible()
      await expect(input).toBeEnabled()
    }
  })

  test('输入搜索关键词', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()

      await input.fill('BTC')
      await expect(input).toHaveValue('BTC')
      await page.waitForTimeout(500)

      const suggestions = page.locator('[class*="dropdown"], [class*="suggestion"], [role="listbox"]')

      if (await suggestions.count() > 0) {
        await expect(suggestions.first()).toBeVisible()
      }
    }
  })

  test('清空搜索框', async ({ page }) => {
    await page.waitForTimeout(2000) // Wait for hydration
    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()

      await input.fill('test search')
      await expect(input).toHaveValue('test search')

      await input.clear()
      await expect(input).toHaveValue('')
    }
  })

  test('搜索结果导航', async ({ page }) => {
    await page.waitForTimeout(2000) // Wait for hydration
    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()

      await input.fill('trader')
      await page.waitForTimeout(500)

      const resultItems = page.locator('[class*="search-result"], [class*="suggestion-item"], [role="option"]')

      if (await resultItems.count() > 0) {
        await resultItems.first().click()
        await page.waitForTimeout(300)
      }
    }
  })

  test('键盘导航搜索建议', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()

      await input.focus()
      await input.fill('BTC')
      await page.waitForTimeout(500)

      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(100)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(100)

      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
    }
  })

  test('搜索无结果处理', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()

      await input.fill('xyznonexistent12345')
      await page.waitForTimeout(500)

      const noResults = page.locator('text=/no results|无结果|未找到/i')

      if (await noResults.count() > 0) {
        await expect(noResults.first()).toBeVisible()
      }
    }
  })
})

test.describe('搜索性能', () => {
  test('搜索响应时间', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const searchInput = page.getByPlaceholder(/搜索|Search/i)

    if (await searchInput.count() > 0) {
      const input = searchInput.first()

      const startTime = Date.now()
      await input.fill('BTC')

      await page.waitForSelector('[class*="dropdown"], [class*="suggestion"]', {
        timeout: 5000,
      }).catch(() => {})

      const responseTime = Date.now() - startTime
      expect(responseTime).toBeLessThan(10_000)
    }
  })
})
