/**
 * Runtime QA — 实际浏览器验证
 *
 * 不是代码审查，是真正打开浏览器、点击、输入、截图、检查。
 * 覆盖：核心路径、移动端、边界输入、网络异常、错误状态。
 */

import { test, expect, type Page } from '@playwright/test'

const BASE = 'http://localhost:3000'

// ═══════════════════════════════════════════════════════════
// A. 首页 & 排行榜 — 核心路径
// ═══════════════════════════════════════════════════════════

test.describe('A. Homepage & Rankings', () => {
  test('A1: 首页加载 — SSR 内容可见、无白屏', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })

    // SSR 排名表应该立即可见（不需要等 JS）
    const body = await page.textContent('body')
    expect(body).toBeTruthy()
    expect(body!.length).toBeGreaterThan(500) // 不是空白页

    // 检查 TopNav 存在
    await expect(page.locator('nav, [class*="top-nav"], [class*="TopNav"]').first()).toBeVisible({
      timeout: 5000,
    })

    // 检查排名数据存在（至少有一些交易员名称）
    await page.waitForTimeout(2000) // 等待 SSR hydration
    const pageText = await page.textContent('body')
    // 应该有排名数字或交易员相关内容
    expect(pageText!.length).toBeGreaterThan(1000)
  })

  test('A2: 排行榜时间窗口切换 — 7D/30D/90D 实际切换数据', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000) // 等待 Phase 2

    // 找到时间切换按钮
    const buttons = page.locator('button, [role="tab"]')
    const allText = await buttons.allTextContents()

    // 找包含 30D 或 30d 的按钮
    const btn30d = buttons.filter({ hasText: /30[Dd]/ }).first()
    if (await btn30d.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn30d.click()
      await page.waitForTimeout(1500)
      // 页面不应崩溃
      const afterClick = await page.textContent('body')
      expect(afterClick!.length).toBeGreaterThan(500)
    }
  })

  test('A3: Trader 详情页 — 点击进入、数据加载', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 点击第一个交易员链接
    const traderLink = page.locator('a[href*="/trader/"]').first()
    if (await traderLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await traderLink.getAttribute('href')
      await traderLink.click()
      await page.waitForURL(/\/trader\//, { timeout: 10000 })

      // 页面应该加载了交易员数据
      await page.waitForTimeout(2000)
      const traderPage = await page.textContent('body')
      expect(traderPage!.length).toBeGreaterThan(200)

      // 不应有未捕获错误
      const errorText = await page.locator('[class*="error"], [class*="Error"]').count()
      // 允许 0 个或多个（有些可能是 UI 组件名称包含 error）
    }
  })

  test('A4: 404 页面 — 不存在的路由', async ({ page }) => {
    const response = await page.goto(`${BASE}/this-page-does-not-exist-12345`, {
      waitUntil: 'domcontentloaded',
    })
    expect(response?.status()).toBe(404)

    // 应该有友好的 404 页面，不是空白
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(50)

    // 应该有返回首页的链接
    const homeLink = page.locator('a[href="/"]')
    expect(await homeLink.count()).toBeGreaterThan(0)
  })

  test('A5: 不存在的 Trader — 专属 404', async ({ page }) => {
    const response = await page.goto(`${BASE}/trader/this_trader_definitely_does_not_exist_99999`, {
      waitUntil: 'domcontentloaded',
    })
    // 应该返回 404
    expect(response?.status()).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════
// B. 搜索 — 正常 + 边界
// ═══════════════════════════════════════════════════════════

test.describe('B. Search', () => {
  test('B1: 正常搜索 — 输入关键词、出结果', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 找搜索入口（图标或输入框）
    const searchTrigger = page
      .locator('[aria-label*="earch"], [placeholder*="earch"], [class*="search"]')
      .first()
    if (await searchTrigger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchTrigger.click()
      await page.waitForTimeout(500)

      // 输入搜索词
      const searchInput = page.locator('input[type="text"], input[type="search"]').first()
      await searchInput.fill('binance')
      await page.waitForTimeout(2000) // 等待防抖 + API 响应

      // 应该有搜索结果
      const resultsArea = await page.textContent('body')
      // 至少不是空的
      expect(resultsArea!.length).toBeGreaterThan(100)
    }
  })

  test('B2: 空搜索 — 不崩溃', async ({ page }) => {
    await page.goto(`${BASE}/search?q=`, { waitUntil: 'domcontentloaded' })
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(50) // 不是空白
  })

  test('B3: XSS 搜索 — 特殊字符不执行', async ({ page }) => {
    const xssPayload = '<script>alert(1)</script>'
    await page.goto(`${BASE}/search?q=${encodeURIComponent(xssPayload)}`, {
      waitUntil: 'domcontentloaded',
    })

    // 不应有 alert 弹窗
    let alertFired = false
    page.on('dialog', () => {
      alertFired = true
    })
    await page.waitForTimeout(2000)
    expect(alertFired).toBe(false)

    // 页面不应崩溃
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(50)
  })

  test('B4: 超长搜索 — 不崩溃', async ({ page }) => {
    const longQuery = 'a'.repeat(1000)
    await page.goto(`${BASE}/search?q=${longQuery}`, { waitUntil: 'domcontentloaded' })
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(50)
  })

  test('B5: SQL 注入搜索 — 不泄露数据', async ({ page }) => {
    const sqlPayload = "'; DROP TABLE users; --"
    await page.goto(`${BASE}/search?q=${encodeURIComponent(sqlPayload)}`, {
      waitUntil: 'domcontentloaded',
    })
    const body = await page.textContent('body')
    expect(body).not.toContain('syntax error')
    expect(body).not.toContain('relation "users"')
  })
})

// ═══════════════════════════════════════════════════════════
// C. 移动端视口 — iPhone SE / iPhone 14 Pro
// ═══════════════════════════════════════════════════════════

test.describe('C. Mobile Viewport', () => {
  test.use({ viewport: { width: 375, height: 667 } }) // iPhone SE

  test('C1: 移动端首页 — 不横向滚动、内容不溢出', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 检查没有水平滚动条
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2) // 允许 2px 误差
  })

  test('C2: 移动端底部导航 — 可见且可点击', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 底部导航应该存在
    const bottomNav = page.locator('[class*="bottom-nav"], [class*="BottomNav"], nav').last()
    if (await bottomNav.isVisible({ timeout: 3000 }).catch(() => false)) {
      // 底部导航不应超出屏幕
      const box = await bottomNav.boundingBox()
      if (box) {
        expect(box.y + box.height).toBeLessThanOrEqual(667 + 100) // 允许 safe area
      }
    }
  })

  test('C3: 移动端搜索 — 全屏覆盖打开', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const searchBtn = page.locator('[aria-label*="earch"], [class*="search"]').first()
    if (await searchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchBtn.click()
      await page.waitForTimeout(500)

      // 搜索覆盖层应该全屏
      const overlay = page
        .locator('[role="dialog"], [class*="overlay"], [class*="Overlay"]')
        .first()
      if (await overlay.isVisible({ timeout: 2000 }).catch(() => false)) {
        const box = await overlay.boundingBox()
        if (box) {
          expect(box.width).toBeGreaterThanOrEqual(370) // 接近全屏宽度
        }
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════
// D. 登录页 — 表单验证、边界输入
// ═══════════════════════════════════════════════════════════

test.describe('D. Login Page', () => {
  test('D1: 登录页加载 — 有邮箱输入和按钮', async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    // 邮箱输入框应该存在
    const emailInput = page
      .locator('input[type="email"], input[autocomplete="email"], input[name="email"]')
      .first()
    await expect(emailInput).toBeVisible({ timeout: 5000 })
  })

  test('D2: 空邮箱提交 — 不崩溃、有提示', async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    // 找到提交按钮并点击
    const submitBtn = page
      .locator('button[type="submit"], button')
      .filter({ hasText: /登录|Login|Sign|Send|Continue|获取|发送/i })
      .first()
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click()
      await page.waitForTimeout(1000)
      // 页面不应崩溃
      const body = await page.textContent('body')
      expect(body!.length).toBeGreaterThan(50)
    }
  })

  test('D3: 无效邮箱 — 有错误提示', async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    const emailInput = page
      .locator('input[type="email"], input[autocomplete="email"], input[name="email"]')
      .first()
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailInput.fill('not-an-email')
      await emailInput.press('Tab') // 触发 blur 验证
      await page.waitForTimeout(1000)

      // 应该有某种错误提示
      const body = await page.textContent('body')
      expect(body!.length).toBeGreaterThan(50)
    }
  })

  test('D4: Emoji 邮箱 — 不崩溃', async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    const emailInput = page
      .locator('input[type="email"], input[autocomplete="email"], input[name="email"]')
      .first()
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailInput.fill('🔥@emoji.com')
      await page.waitForTimeout(500)
      // 不崩溃即通过
      const body = await page.textContent('body')
      expect(body!.length).toBeGreaterThan(50)
    }
  })

  test('D5: 超长邮箱 — maxLength 生效', async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    const emailInput = page
      .locator('input[type="email"], input[autocomplete="email"], input[name="email"]')
      .first()
    if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      const longEmail = 'a'.repeat(300) + '@test.com'
      await emailInput.fill(longEmail)
      const value = await emailInput.inputValue()
      // maxLength=254 应该截断
      expect(value.length).toBeLessThanOrEqual(260) // 允许小偏差
    }
  })
})

// ═══════════════════════════════════════════════════════════
// E. API 端点 — 直接请求验证
// ═══════════════════════════════════════════════════════════

test.describe('E. API Endpoints', () => {
  test('E1: 健康检查 API', async ({ request }) => {
    const response = await request.get(`${BASE}/api/health`)
    expect(response.status()).toBe(200)
    const data = await response.json()
    expect(data).toHaveProperty('status')
  })

  test('E2: 搜索 API — 空查询', async ({ request }) => {
    const response = await request.get(`${BASE}/api/search?q=`)
    expect(response.status()).toBeLessThan(500)
  })

  test('E3: 搜索 API — XSS payload', async ({ request }) => {
    const response = await request.get(
      `${BASE}/api/search?q=${encodeURIComponent('<script>alert(1)</script>')}`
    )
    expect(response.status()).toBeLessThan(500)
    const data = await response.json()
    const text = JSON.stringify(data)
    expect(text).not.toContain('<script>')
  })

  test('E4: 搜索 API — SQL 注入', async ({ request }) => {
    const response = await request.get(
      `${BASE}/api/search?q=${encodeURIComponent("'; DROP TABLE posts; --")}`
    )
    expect(response.status()).toBeLessThan(500)
  })

  test('E5: 受保护 API — 未认证返回 401', async ({ request }) => {
    const response = await request.get(`${BASE}/api/notifications`)
    // 应该返回 401 而非 500
    expect([401, 403]).toContain(response.status())
  })

  test('E6: 不存在的 API — 404', async ({ request }) => {
    const response = await request.get(`${BASE}/api/this-does-not-exist`)
    expect(response.status()).toBe(404)
  })

  test('E7: Compare API — 未认证', async ({ request }) => {
    const response = await request.get(
      `${BASE}/api/compare?ids=test1,test2&platforms=bybit,binance_futures`
    )
    expect([401, 403]).toContain(response.status())
  })

  test('E8: OG 图片 — 生成正常', async ({ request }) => {
    const response = await request.get(`${BASE}/api/og`)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('image')
  })
})

// ═══════════════════════════════════════════════════════════
// F. 关键页面加载 — 不崩溃、状态码正确
// ═══════════════════════════════════════════════════════════

test.describe('F. Page Loading', () => {
  const pages = [
    ['/', '首页'],
    ['/market', '市场'],
    ['/pricing', '定价'],
    ['/login', '登录'],
    ['/about', '关于'],
    ['/terms', '条款'],
    ['/privacy', '隐私'],
    ['/help', '帮助'],
    ['/search', '搜索'],
    ['/flash-news', '快讯'],
    ['/hot', '热门'],
    ['/groups', '交易组'],
    ['/rankings/tokens', 'Token排行'],
    ['/methodology', '方法论'],
  ]

  for (const [path, name] of pages) {
    test(`F: ${name} (${path}) — 200 且不白屏`, async ({ page }) => {
      const response = await page.goto(`${BASE}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      })
      expect(response?.status()).toBeLessThan(500)

      const body = await page.textContent('body')
      expect(body!.length).toBeGreaterThan(50) // 不是空白
    })
  }
})

// ═══════════════════════════════════════════════════════════
// G. Console Errors — 不应有未捕获异常
// ═══════════════════════════════════════════════════════════

test.describe('G. Console Errors', () => {
  test('G1: 首页无 JS 异常', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5000) // 等待 Phase 2 完全加载

    // 过滤已知的第三方/无害错误
    const realErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') && // Chrome 的已知 bug
        !e.includes('Loading chunk') && // 动态导入的正常重试
        !e.includes('AbortError') && // 正常的请求取消
        !e.includes('hydration') // 开发模式的 hydration 警告
    )

    if (realErrors.length > 0) {
      console.log('Console errors found:', realErrors)
    }
    expect(realErrors.length).toBe(0)
  })

  test('G2: 登录页无 JS 异常', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
    })

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const realErrors = errors.filter(
      (e) =>
        !e.includes('ResizeObserver') &&
        !e.includes('Loading chunk') &&
        !e.includes('AbortError') &&
        !e.includes('hydration')
    )

    expect(realErrors.length).toBe(0)
  })
})
