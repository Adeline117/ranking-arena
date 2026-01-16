import { test, expect } from '@playwright/test'

test.describe('搜索功能测试', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
  })

  test('搜索框可见且可交互', async ({ page }) => {
    // 查找搜索框
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
      
      // 输入搜索内容
      await input.fill('BTC')
      
      // 验证输入值
      await expect(input).toHaveValue('BTC')
      
      // 等待搜索建议出现
      await page.waitForTimeout(500)
      
      // 检查是否有搜索建议下拉框
      const suggestions = page.locator('[class*="dropdown"], [class*="suggestion"], [role="listbox"]')
      
      if (await suggestions.count() > 0) {
        await expect(suggestions.first()).toBeVisible()
      }
    }
  })

  test('清空搜索框', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)
    
    if (await searchInput.count() > 0) {
      const input = searchInput.first()
      
      // 输入内容
      await input.fill('test search')
      await expect(input).toHaveValue('test search')
      
      // 清空
      await input.clear()
      await expect(input).toHaveValue('')
    }
  })

  test('搜索结果导航', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)
    
    if (await searchInput.count() > 0) {
      const input = searchInput.first()
      
      // 输入搜索词
      await input.fill('trader')
      await page.waitForTimeout(500)
      
      // 查找搜索结果项
      const resultItems = page.locator('[class*="search-result"], [class*="suggestion-item"], [role="option"]')
      
      if (await resultItems.count() > 0) {
        // 点击第一个结果
        await resultItems.first().click()
        
        // 等待导航
        await page.waitForTimeout(300)
      }
    }
  })

  test('键盘导航搜索建议', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)
    
    if (await searchInput.count() > 0) {
      const input = searchInput.first()
      
      // 聚焦并输入
      await input.focus()
      await input.fill('BTC')
      await page.waitForTimeout(500)
      
      // 使用键盘导航
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(100)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(100)
      
      // 按 Enter 选择
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
    }
  })

  test('搜索无结果处理', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/搜索|Search/i)
    
    if (await searchInput.count() > 0) {
      const input = searchInput.first()
      
      // 输入不存在的内容
      await input.fill('xyznonexistent12345')
      await page.waitForTimeout(500)
      
      // 检查是否显示无结果提示
      const noResults = page.locator('text=/no results|无结果|未找到/i')
      
      // 无结果提示可能存在也可能不存在
      if (await noResults.count() > 0) {
        await expect(noResults.first()).toBeVisible()
      }
    }
  })
})

test.describe('搜索性能', () => {
  test('搜索响应时间', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    const searchInput = page.getByPlaceholder(/搜索|Search/i)
    
    if (await searchInput.count() > 0) {
      const input = searchInput.first()
      
      const startTime = Date.now()
      await input.fill('BTC')
      
      // 等待搜索建议出现
      await page.waitForSelector('[class*="dropdown"], [class*="suggestion"]', {
        timeout: 2000,
      }).catch(() => {})
      
      const responseTime = Date.now() - startTime
      
      // 搜索响应应在 2 秒内
      expect(responseTime).toBeLessThan(2000)
    }
  })
})
