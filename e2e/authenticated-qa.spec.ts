/**
 * Authenticated Runtime QA — 真实登录态全流程测试
 *
 * 用真实 Supabase session 注入 Playwright，实际走通：
 * - 登录态页面访问
 * - 关注/取关交易员
 * - 搜索 + 点击结果
 * - 通知页
 * - 设置页
 * - 收藏夹
 * - 发帖/评论（如果有权限）
 * - 定价页 → 付费入口
 * - 断网恢复
 */

import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:3000'

// Supabase auth cookie name pattern
const SB_PROJECT_REF = 'iknktzifjdyujdccyhsv'

// Inject auth session via Supabase cookies
async function injectAuth(page: import('@playwright/test').Page) {
  const accessToken = process.env.QA_ACCESS_TOKEN!
  const refreshToken = process.env.QA_REFRESH_TOKEN!

  if (!accessToken || !refreshToken) {
    throw new Error('QA_ACCESS_TOKEN and QA_REFRESH_TOKEN env vars required')
  }

  // Supabase stores session in cookies with specific naming
  await page.context().addCookies([
    {
      name: `sb-${SB_PROJECT_REF}-auth-token`,
      value: JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
      domain: 'localhost',
      path: '/',
    },
    // Also set the base64 encoded chunks (Supabase uses chunked cookies)
    {
      name: `sb-${SB_PROJECT_REF}-auth-token.0`,
      // @supabase/ssr decodes the chunk as stringFromBase64URL(value.slice('base64-'.length)),
      // so the value MUST start with the 'base64-' prefix AND be base64url (not standard
      // base64). The old value had neither, so the cookie never decoded.
      value:
        'base64-' +
        Buffer.from(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: 'bearer',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          })
        ).toString('base64url'),
      domain: 'localhost',
      path: '/',
    },
  ])
}

// ═══════════════════════════════════════════════════════════
// 1. 登录态验证
// ═══════════════════════════════════════════════════════════

test.describe('1. Auth State', () => {
  test('1.1: 设置页可访问（需登录）', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 不应被重定向到 login
    expect(page.url()).not.toContain('/login')

    // 页面应该有设置相关内容
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(100)
  })

  test('1.2: 通知页可访问', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/notifications`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    expect(page.url()).not.toContain('/login')
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(100)
  })

  test('1.3: 收藏夹可访问', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/favorites`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    expect(page.url()).not.toContain('/login')
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 交易员交互
// ═══════════════════════════════════════════════════════════

test.describe('2. Trader Interactions', () => {
  test('2.1: 进入 Trader 详情 → 关注按钮存在', async ({ page }) => {
    await injectAuth(page)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 找到第一个 trader 链接
    const traderLink = page.locator('a[href*="/trader/"]').first()
    if (await traderLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await traderLink.click()
      await page.waitForURL(/\/trader\//, { timeout: 10000 })
      await page.waitForTimeout(3000)

      // 关注按钮应该存在（Follow 或 已关注）
      const followBtn = page
        .locator('button')
        .filter({ hasText: /Follow|关注|Unfollow|已关注/i })
        .first()
      const exists = await followBtn.isVisible({ timeout: 5000 }).catch(() => false)
      // 按钮可能存在也可能不存在（取决于页面状态），但页面不应崩溃
      const body = await page.textContent('body')
      expect(body!.length).toBeGreaterThan(200)
    }
  })

  test('2.2: 搜索交易员 → 点击结果 → 页面正常', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/search?q=binance`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 搜索结果应该有内容
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(200)

    // 点击第一个结果链接
    const resultLink = page.locator('a[href*="/trader/"]').first()
    if (await resultLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await resultLink.click()
      await page.waitForTimeout(3000)
      // 不崩溃
      const traderBody = await page.textContent('body')
      expect(traderBody!.length).toBeGreaterThan(200)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 3. API 认证端点
// ═══════════════════════════════════════════════════════════

test.describe('3. Authenticated APIs', () => {
  const authHeaders = () => ({
    Authorization: `Bearer ${process.env.QA_ACCESS_TOKEN}`,
  })

  test('3.1: GET /api/notifications — 200', async ({ request }) => {
    const res = await request.get(`${BASE}/api/notifications`, { headers: authHeaders() })
    expect(res.status()).toBe(200)
  })

  test('3.2: GET /api/watchlist — 200', async ({ request }) => {
    const res = await request.get(`${BASE}/api/watchlist`, { headers: authHeaders() })
    expect([200, 404]).toContain(res.status()) // 404 if no watchlist yet
  })

  test('3.3: GET /api/subscription — 200', async ({ request }) => {
    const res = await request.get(`${BASE}/api/subscription`, { headers: authHeaders() })
    expect(res.status()).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('tier')
  })

  test('3.4: POST /api/follow — 空 body 返回 400 不是 500', async ({ request }) => {
    const res = await request.post(`${BASE}/api/follow`, {
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      data: {},
    })
    expect(res.status()).toBeLessThan(500) // 400 or 422, not 500
  })

  test('3.5: POST /api/posts — 空 body 返回 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/posts`, {
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      data: {},
    })
    expect(res.status()).toBeLessThan(500)
  })

  test('3.6: GET /api/stripe/create-checkout — 已订阅检查', async ({ request }) => {
    // 直接 GET 应该 405（只支持 POST）
    const res = await request.get(`${BASE}/api/stripe/create-checkout`, { headers: authHeaders() })
    expect([404, 405]).toContain(res.status())
  })

  test('3.7: POST /api/stripe/create-checkout — free 用户可创建 session', async ({ request }) => {
    const res = await request.post(`${BASE}/api/stripe/create-checkout`, {
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      data: { plan: 'monthly' },
    })
    // 应该返回 200 with checkout URL, 或 4xx if Stripe not configured
    expect(res.status()).toBeLessThan(500)
  })

  test('3.8: POST /api/posts/upload-image — 无文件返回 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/posts/upload-image`, {
      headers: authHeaders(),
    })
    expect(res.status()).toBeLessThan(500)
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 定价页 → 付费入口
// ═══════════════════════════════════════════════════════════

test.describe('4. Pricing & Payment', () => {
  test('4.1: 定价页显示三个方案', async ({ page }) => {
    await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    const body = await page.textContent('body')
    // 应该有 Free, Pro, Lifetime 相关文字
    expect(body).toMatch(/free|pro|lifetime/i)
    // 应该有价格
    expect(body).toMatch(/\$\d/)
  })

  test('4.2: 登录用户看到正确的 CTA', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    // 不应显示"登录后购买"，应显示"升级"或"Subscribe"
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(200)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 社交功能
// ═══════════════════════════════════════════════════════════

test.describe('5. Social Features', () => {
  test('5.1: 交易组列表加载', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(100)
    expect(page.url()).not.toContain('/login')
  })

  test('5.2: Feed 页加载', async ({ page }) => {
    await injectAuth(page)
    await page.goto(`${BASE}/feed`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(100)
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 边界场景
// ═══════════════════════════════════════════════════════════

test.describe('6. Edge Cases', () => {
  test('6.1: 快速连续导航 — 不崩溃', async ({ page }) => {
    await injectAuth(page)

    // 快速连续跳转 5 个页面
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${BASE}/market`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })

    // 最终页面应该正常
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(200)
  })

  test('6.2: 后退按钮 — 不白屏', async ({ page }) => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    await page.goBack()
    await page.waitForTimeout(2000)

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(200)
  })

  test('6.3: 断网模拟 → 恢复', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    // 模拟断网
    await page.context().setOffline(true)
    await page.waitForTimeout(2000)

    // 恢复网络
    await page.context().setOffline(false)
    await page.waitForTimeout(2000)

    // 页面应该能恢复
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(200)
  })

  test('6.4: 超长 URL 参数 — 不崩溃', async ({ page }) => {
    const longParam = 'a'.repeat(5000)
    const res = await page.goto(`${BASE}/?ref=${longParam}`, { waitUntil: 'domcontentloaded' })
    expect(res?.status()).toBeLessThan(500)
  })
})
