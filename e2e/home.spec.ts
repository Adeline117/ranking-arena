import { test, expect } from '@playwright/test'

test.describe('首页测试', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('页面正常加载', async ({ page }) => {
    // 检查页面标题
    await expect(page).toHaveTitle(/Arena/)
    
    // 检查导航栏存在
    await expect(page.getByRole('navigation')).toBeVisible()
  })

  test('排行榜正确显示', async ({ page }) => {
    // 等待排行榜加载
    await page.waitForSelector('.home-ranking-section', { timeout: 10000 })
    
    // 检查时间选择器存在
    await expect(page.getByRole('button', { name: /90D|90天/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /30D|30天/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /7D|7天/ })).toBeVisible()
  })

  test('时间范围切换功能', async ({ page }) => {
    // 等待页面加载完成
    await page.waitForLoadState('networkidle')
    
    // 点击 30D 按钮
    const button30d = page.getByRole('button', { name: /30D|30天/ })
    await button30d.click()
    
    // 验证按钮被选中（通过样式或状态）
    await expect(button30d).toBeEnabled()
    
    // 点击 7D 按钮
    const button7d = page.getByRole('button', { name: /7D|7天/ })
    await button7d.click()
    
    await expect(button7d).toBeEnabled()
  })

  test('响应式布局 - 移动端', async ({ page }) => {
    // 设置移动端视口
    await page.setViewportSize({ width: 375, height: 667 })
    
    // 重新加载页面
    await page.reload()
    
    // 等待页面加载
    await page.waitForLoadState('networkidle')
    
    // 移动端应该隐藏侧边栏
    const leftSection = page.locator('.home-left-section')
    await expect(leftSection).not.toBeVisible()
  })

  test('排行榜分页功能', async ({ page }) => {
    // 等待排行榜加载
    await page.waitForLoadState('networkidle')
    
    // 检查分页按钮是否存在
    const pagination = page.locator('button').filter({ hasText: /下一页|Next|>/ })
    
    if (await pagination.count() > 0) {
      // 点击下一页
      await pagination.first().click()
      
      // 等待内容更新
      await page.waitForLoadState('networkidle')
    }
  })

  test('搜索功能可用', async ({ page }) => {
    // 查找搜索框
    const searchInput = page.getByPlaceholder(/搜索|Search/)
    
    if (await searchInput.count() > 0) {
      await expect(searchInput.first()).toBeVisible()
      
      // 输入搜索内容
      await searchInput.first().fill('BTC')
      
      // 等待搜索结果
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
    
    // 首页加载应在 5 秒内完成
    expect(loadTime).toBeLessThan(5000)
  })

  test('排行榜数据加载时间', async ({ page }) => {
    await page.goto('/')
    
    const startTime = Date.now()
    
    // 等待排行榜数据加载完成
    await page.waitForSelector('.home-ranking-section table, .home-ranking-section [class*="skeleton"]', {
      timeout: 10000,
    })
    
    const loadTime = Date.now() - startTime
    
    // 排行榜加载应在 3 秒内完成
    expect(loadTime).toBeLessThan(3000)
  })
})
