import { test, expect } from '@playwright/test'

test.describe('交易员详情页测试', () => {
  test('从排行榜导航到交易员详情', async ({ page }) => {
    await page.goto('/')
    
    // 等待排行榜加载
    await page.waitForLoadState('networkidle')
    
    // 查找交易员链接
    const traderLinks = page.locator('a[href*="/trader/"]')
    
    if (await traderLinks.count() > 0) {
      // 获取第一个交易员的链接
      const firstTraderLink = traderLinks.first()
      const href = await firstTraderLink.getAttribute('href')
      
      // 点击链接
      await firstTraderLink.click()
      
      // 等待页面导航
      await page.waitForURL(`**${href}`)
      
      // 验证页面加载成功
      await expect(page.locator('body')).toBeVisible()
    }
  })

  test('交易员详情页核心元素', async ({ page }) => {
    // 直接访问一个交易员页面（使用通用路径）
    await page.goto('/trader/test')
    
    // 等待页面加载
    await page.waitForLoadState('domcontentloaded')
    
    // 如果交易员存在，检查页面元素
    const notFoundText = page.getByText(/not found|不存在|404/i)
    
    if (await notFoundText.count() === 0) {
      // 检查基本元素是否存在
      // 这些选择器需要根据实际页面结构调整
      const header = page.locator('[class*="header"], [class*="Header"]')
      if (await header.count() > 0) {
        await expect(header.first()).toBeVisible()
      }
    }
  })

  test('交易员页面 Tab 切换', async ({ page }) => {
    // 从首页获取真实的交易员
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    const traderLinks = page.locator('a[href*="/trader/"]')
    
    if (await traderLinks.count() > 0) {
      await traderLinks.first().click()
      await page.waitForLoadState('networkidle')
      
      // 查找 Tab 按钮
      const tabs = page.locator('button, [role="tab"]').filter({
        hasText: /Overview|概览|Stats|统计|Portfolio|持仓|Chart|图表/i,
      })
      
      if (await tabs.count() > 1) {
        // 点击第二个 Tab
        await tabs.nth(1).click()
        
        // 等待内容切换
        await page.waitForTimeout(300)
      }
    }
  })

  test('交易员关注功能（需登录）', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    const traderLinks = page.locator('a[href*="/trader/"]')
    
    if (await traderLinks.count() > 0) {
      await traderLinks.first().click()
      await page.waitForLoadState('networkidle')
      
      // 查找关注按钮
      const followButton = page.locator('button').filter({
        hasText: /Follow|关注/i,
      })
      
      if (await followButton.count() > 0) {
        // 未登录状态下点击应该提示登录
        await followButton.first().click()
        
        // 可能会弹出登录提示或跳转到登录页
        await page.waitForTimeout(500)
      }
    }
  })
})

test.describe('交易员详情页性能', () => {
  test('详情页加载时间', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    
    const traderLinks = page.locator('a[href*="/trader/"]')
    
    if (await traderLinks.count() > 0) {
      const href = await traderLinks.first().getAttribute('href')
      
      const startTime = Date.now()
      await page.goto(href!)
      await page.waitForLoadState('domcontentloaded')
      
      const loadTime = Date.now() - startTime
      
      // 详情页加载应在 4 秒内完成
      expect(loadTime).toBeLessThan(4000)
    }
  })
})
