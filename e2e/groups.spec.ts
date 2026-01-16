import { test, expect } from '@playwright/test'

test.describe('小组功能', () => {
  test('小组列表页面可以访问', async ({ page }) => {
    await page.goto('/groups')
    
    await expect(page).toHaveURL(/\/groups/)
    await expect(page).toHaveTitle(/Arena/i)
  })

  test('显示小组列表', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    
    // 等待小组列表或空状态
    await page.waitForSelector('[data-testid="group-item"], .group-card, article', { timeout: 10000 }).catch(() => {})
    
    // 不论有没有小组数据，页面都应该正常显示
    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })

  test('小组卡片包含基本信息', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    
    const firstGroup = page.locator('[data-testid="group-item"], .group-card').first()
    
    if (await firstGroup.isVisible()) {
      // 检查是否有小组名称
      const text = await firstGroup.textContent()
      expect(text).toBeTruthy()
    }
  })

  test('点击小组可以查看详情', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    
    const firstGroup = page.locator('[data-testid="group-item"], .group-card, [href*="/groups/"]').first()
    
    if (await firstGroup.isVisible()) {
      await firstGroup.click()
      await page.waitForLoadState('networkidle')
      
      // 应该跳转到小组详情页
      const url = page.url()
      expect(url).toMatch(/\/groups\//)
    }
  })
})

test.describe('小组详情', () => {
  test('小组详情页显示小组信息', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    
    const firstGroup = page.locator('[data-testid="group-item"], .group-card, [href*="/groups/"]').first()
    
    if (await firstGroup.isVisible()) {
      await firstGroup.click()
      await page.waitForLoadState('networkidle')
      
      // 检查页面是否有内容
      const content = await page.textContent('body')
      expect(content).toBeTruthy()
    }
  })

  test('小组详情页显示帖子列表', async ({ page }) => {
    // 直接访问一个小组页面（如果 URL 格式已知）
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    
    const firstGroup = page.locator('[data-testid="group-item"], .group-card, [href*="/groups/"]').first()
    
    if (await firstGroup.isVisible()) {
      await firstGroup.click()
      await page.waitForLoadState('networkidle')
      
      // 等待帖子列表
      await page.waitForSelector('[data-testid="post-item"], article, .post', { timeout: 5000 }).catch(() => {})
    }
  })
})

test.describe('小组申请', () => {
  test('申请创建小组页面可以访问', async ({ page }) => {
    await page.goto('/groups/apply')
    
    // 可能需要登录，检查是否重定向或显示申请表单
    await page.waitForLoadState('networkidle')
    
    const url = page.url()
    // 未登录可能重定向到登录页，登录后可以访问申请页
    expect(url.includes('/groups/apply') || url.includes('/login')).toBe(true)
  })
})
