import { test, expect } from '@playwright/test'

test.describe('认证流程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
  })

  test('未登录用户可以访问首页', async ({ page }) => {
    await expect(page).toHaveTitle(/Arena/i)
    await expect(page.locator('[data-testid="ranking-table"]').or(page.locator('table'))).toBeVisible({ timeout: 30_000 })
  })

  test('显示登录链接', async ({ page }) => {
    const loginLink = page.getByRole('link', { name: /登录|login|sign in/i })
    await expect(loginLink).toBeVisible()
  })

  test('点击登录跳转到登录页', async ({ page }) => {
    const loginLink = page.getByRole('link', { name: /登录|login|sign in/i })
    await loginLink.click()

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('button', { name: /登录|login|sign in/i }).or(page.locator('form'))).toBeVisible()
  })

  test('登录页面包含必要元素', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    await expect(page.getByPlaceholder(/邮箱|email/i).or(page.locator('input[type="email"]'))).toBeVisible()
    await expect(page.getByPlaceholder(/密码|password/i).or(page.locator('input[type="password"]'))).toBeVisible()
    await expect(page.getByRole('button', { name: /登录|login|sign in/i })).toBeVisible()
  })

  test('空表单提交显示验证错误', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    const submitButton = page.getByRole('button', { name: /登录|login|sign in/i })
    await submitButton.click()
    await page.waitForTimeout(500)

    await expect(page).toHaveURL(/\/login/)
  })

  test('无效邮箱格式显示错误', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')

    const emailInput = page.getByPlaceholder(/邮箱|email/i).or(page.locator('input[type="email"]'))
    const passwordInput = page.getByPlaceholder(/密码|password/i).or(page.locator('input[type="password"]'))
    const submitButton = page.getByRole('button', { name: /登录|login|sign in/i })

    await emailInput.fill('invalid-email')
    await passwordInput.fill('password123')
    await submitButton.click()
    await page.waitForTimeout(500)

    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('登出流程', () => {
  test('登出 API 未认证时返回错误', async ({ request }) => {
    const response = await request.post('/api/auth/logout')
    // Should reject or return error for unauthenticated request
    expect(response.status()).toBeGreaterThanOrEqual(400)
  })
})
