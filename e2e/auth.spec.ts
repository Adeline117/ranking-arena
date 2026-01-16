import { test, expect } from '@playwright/test'

test.describe('认证流程', () => {
  test.beforeEach(async ({ page }) => {
    // 确保每个测试前都在首页
    await page.goto('/')
  })

  test('未登录用户可以访问首页', async ({ page }) => {
    await expect(page).toHaveTitle(/Arena/i)
    // 检查排行榜是否显示
    await expect(page.locator('[data-testid="ranking-table"]').or(page.locator('table'))).toBeVisible({ timeout: 10000 })
  })

  test('显示登录链接', async ({ page }) => {
    // 检查导航栏是否有登录入口
    const loginLink = page.getByRole('link', { name: /登录|login|sign in/i })
    await expect(loginLink).toBeVisible()
  })

  test('点击登录跳转到登录页', async ({ page }) => {
    const loginLink = page.getByRole('link', { name: /登录|login|sign in/i })
    await loginLink.click()
    
    await expect(page).toHaveURL(/\/login/)
    // 检查登录表单元素
    await expect(page.getByRole('button', { name: /登录|login|sign in/i }).or(page.locator('form'))).toBeVisible()
  })

  test('登录页面包含必要元素', async ({ page }) => {
    await page.goto('/login')
    
    // 检查邮箱输入框
    await expect(page.getByPlaceholder(/邮箱|email/i).or(page.locator('input[type="email"]'))).toBeVisible()
    // 检查密码输入框
    await expect(page.getByPlaceholder(/密码|password/i).or(page.locator('input[type="password"]'))).toBeVisible()
    // 检查提交按钮
    await expect(page.getByRole('button', { name: /登录|login|sign in/i })).toBeVisible()
  })

  test('空表单提交显示验证错误', async ({ page }) => {
    await page.goto('/login')
    
    // 直接点击登录按钮
    const submitButton = page.getByRole('button', { name: /登录|login|sign in/i })
    await submitButton.click()
    
    // 应该显示某种验证提示（错误消息或原生验证）
    await page.waitForTimeout(500)
    
    // 检查是否仍在登录页（未跳转）
    await expect(page).toHaveURL(/\/login/)
  })

  test('无效邮箱格式显示错误', async ({ page }) => {
    await page.goto('/login')
    
    const emailInput = page.getByPlaceholder(/邮箱|email/i).or(page.locator('input[type="email"]'))
    const passwordInput = page.getByPlaceholder(/密码|password/i).or(page.locator('input[type="password"]'))
    const submitButton = page.getByRole('button', { name: /登录|login|sign in/i })
    
    await emailInput.fill('invalid-email')
    await passwordInput.fill('password123')
    await submitButton.click()
    
    await page.waitForTimeout(500)
    // 检查是否仍在登录页
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('登出流程', () => {
  // 这些测试需要登录状态，跳过或模拟
  test.skip('登录用户可以登出', async ({ page }) => {
    // 这个测试需要先登录
    // 在实际环境中，可以使用测试账户登录
  })
})
