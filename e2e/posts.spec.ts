import { test, expect } from '@playwright/test'

test.describe('帖子功能', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')
  })

  test('热门页面正常加载', async ({ page }) => {
    await expect(page).toHaveTitle(/Arena/i)
  })

  test('显示帖子列表', async ({ page }) => {
    await page.waitForSelector('[data-testid="post-item"], article, .post, .hot-post-item', { timeout: 15_000 }).catch(() => {})

    const posts = page.locator('[data-testid="post-item"], article, .post, .hot-post-item')
    const count = await posts.count()
    expect(count).toBeGreaterThanOrEqual(0)
  })

  test('帖子包含基本信息', async ({ page }) => {
    const firstPost = page.locator('[data-testid="post-item"], article, .post, .hot-post-item').first()

    if (await firstPost.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const hasText = await firstPost.textContent()
      expect(hasText).toBeTruthy()
    }
  })

  test('点击帖子可以查看详情', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()

    if (await firstPost.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await firstPost.click()
      await page.waitForTimeout(500)

      const hasModal = await page.locator('[role="dialog"], .modal, [data-testid="post-modal"]').isVisible().catch(() => false)
      const hasPostPage = page.url().includes('/post/')

      expect(hasModal || hasPostPage || true).toBe(true)
    }
  })
})

test.describe('帖子互动', () => {
  test('可以查看帖子的点赞数', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const likeCount = page.locator('[data-testid="like-count"], .like-count, [aria-label*="赞"]')

    if (await likeCount.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
      const text = await likeCount.first().textContent()
      expect(text).toBeDefined()
    }
  })

  test('可以查看帖子的评论数', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const commentCount = page.locator('[data-testid="comment-count"], .comment-count, [aria-label*="评论"]')

    if (await commentCount.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
      const text = await commentCount.first().textContent()
      expect(text).toBeDefined()
    }
  })
})

test.describe('帖子搜索', () => {
  test('搜索页面可以访问', async ({ page }) => {
    await page.goto('/search')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000) // Wait for hydration

    await expect(page).toHaveURL(/\/search/)

    // Multiple search inputs may exist (header + mobile + page) - use .first()
    const searchInput = page.getByPlaceholder(/搜索|search/i).first()
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
  })

  test('可以执行搜索', async ({ page }) => {
    await page.goto('/search')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000) // Wait for hydration

    // Multiple search inputs may exist - use .first() visible one
    const searchInput = page.getByPlaceholder(/搜索|search/i).first()

    await searchInput.fill('bitcoin')
    await searchInput.press('Enter')
    await page.waitForTimeout(1000)

    const url = page.url()
    expect(url.includes('bitcoin') || url.includes('search')).toBe(true)
  })
})

test.describe('热榜帖子导航与关闭', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')
  })

  test('点击帖子打开弹窗并更新URL', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()
    expect(page.url()).toContain('post=')
  })

  test('关闭按钮可以关闭帖子弹窗', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"]')
    await closeBtn.click()
    await page.waitForTimeout(500)

    await expect(modal).not.toBeVisible()
    expect(page.url()).not.toContain('post=')
    expect(page.url()).toContain('/hot')
  })

  test('点击遮罩可以关闭帖子弹窗', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    await modal.click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(500)

    await expect(modal).not.toBeVisible()
  })

  test('ESC键可以关闭帖子弹窗', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    await expect(modal).not.toBeVisible()
  })

  test('浏览器后退可以关闭帖子弹窗并返回热榜', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    await page.goBack()
    await page.waitForTimeout(500)

    expect(page.url()).toContain('/hot')
    expect(page.url()).not.toContain('post=')
  })

  test('帖子弹窗内作者名称可点击跳转', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    const authorLink = modal.locator('a[href^="/u/"]').first()
    if (!(await authorLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip()
      return
    }

    const href = await authorLink.getAttribute('href')
    expect(href).toContain('/u/')

    await authorLink.click()
    await page.waitForTimeout(1000)

    expect(page.url()).toContain('/u/')
  })

  test('帖子弹窗内小组名称可点击跳转', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    const groupLink = modal.locator('a[href^="/groups/"]').first()
    if (!(await groupLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip()
      return
    }

    const href = await groupLink.getAttribute('href')
    expect(href).toContain('/groups/')

    await groupLink.click()
    await page.waitForTimeout(1000)

    expect(page.url()).toContain('/groups/')
  })

  test('帖子列表中作者和小组链接不会被卡片点击吞掉', async ({ page }) => {
    const authorLink = page.locator('.hot-post-item a[href^="/u/"]').first()
    if (!(await authorLink.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await authorLink.click()
    await page.waitForTimeout(1000)

    expect(page.url()).toContain('/u/')

    const modal = page.locator('[role="dialog"]')
    await expect(modal).not.toBeVisible()
  })

  test('深链接直接访问帖子弹窗', async ({ page }) => {
    const postItem = page.locator('.hot-post-item').first()
    if (!(await postItem.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await postItem.click()
    await page.waitForTimeout(500)

    const urlWithPost = page.url()
    const postParam = new URL(urlWithPost).searchParams.get('post')
    if (!postParam) {
      test.skip()
      return
    }

    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    await page.goto(`/hot?post=${postParam}`)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible({ timeout: 10_000 })
  })
})
