/**
 * 按钮审计回归测试 — 2026-06 全站按钮功能深度根源测试中发现的崩溃类 bug
 *
 * 每个用例对应一个已修复的根因类，防止回归：
 * 1. i18n 非法 locale 导致整页崩溃（t('locale') / formatTimeAgo monthsAgo TypeError）
 * 2. 本地路径头像被误裹进 /api/avatar 代理（400）
 * 3. 匿名访客触发 auth-required API（translate/interactions 401/403 console 噪音）
 */

import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000'
const LANGS = ['en', 'zh', 'ja', 'ko'] as const

async function collectErrors(page: Page) {
  const pageErrors: string[] = []
  const badRequests: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('response', (r) => {
    if (r.status() >= 400) badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`)
  })
  return { pageErrors, badRequests }
}

test.describe('回归 1: /hot 多语言渲染不崩溃（monthsAgo TypeError 类）', () => {
  for (const lang of LANGS) {
    test(`/hot 在 ${lang} 下无错误边界、无页面级异常`, async ({ page }) => {
      const { pageErrors } = await collectErrors(page)
      await page.addInitScript((l) => {
        try {
          localStorage.setItem('language', l)
        } catch {
          /* ignore */
        }
      }, lang)
      await page.goto(`${BASE}/hot`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(6000)

      const body = await page.evaluate(() => document.body.innerText)
      expect(body).not.toContain('Something went wrong')
      // formatTimeAgo 对未知 locale 兜底 en（lib/utils/date.ts）—
      // 任何 'monthsAgo' / 'reading' TypeError 都意味着兜底被破坏
      const localeErrors = pageErrors.filter((e) => /monthsAgo|Cannot read properties/.test(e))
      expect(localeErrors).toEqual([])
    })
  }
})

test.describe('回归 2: 本地路径头像不进 /api/avatar 代理（avatarSrc 类）', () => {
  test('首页 + /hot 无 /api/avatar?url=%2F...（本地路径误代理 = 必然 400）', async ({ page }) => {
    const proxiedLocalPaths: string[] = []
    page.on('request', (r) => {
      const u = r.url()
      // /api/avatar?url=<encoded> 且 decoded 以 / 开头（本地路径）即违规
      const m = u.match(/\/api\/avatar\?url=([^&]+)/)
      if (m && decodeURIComponent(m[1]).startsWith('/')) proxiedLocalPaths.push(u)
    })
    for (const path of ['/', '/hot']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(5000)
    }
    expect(proxiedLocalPaths).toEqual([])
  })
})

test.describe('回归 3: 匿名访客不触发 auth-required API（401/403 噪音类）', () => {
  test('未登录浏览核心页面，无 translate/interactions 的 401/403', async ({ page }) => {
    const authNoise: string[] = []
    page.on('response', (r) => {
      if (
        (r.status() === 401 || r.status() === 403) &&
        /\/api\/(translate|interactions|track)/.test(r.url())
      ) {
        authNoise.push(`${r.status()} ${r.url()}`)
      }
    })
    for (const path of ['/', '/hot', '/market', '/pricing']) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(5000)
    }
    // 埋点 flush 在 visibilitychange 触发 — 模拟切后台
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(2000)
    expect(authNoise).toEqual([])
  })
})
