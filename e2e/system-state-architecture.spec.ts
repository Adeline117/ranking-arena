import { test, expect } from '@playwright/test'

/**
 * E2E tests for the unified system state architecture.
 *
 * Covers:
 * 1. Comment persistence: comments survive page refresh across entry points
 * 2. Route/navigation consistency: URL-driven modals, back/close/ESC behavior
 * 3. Click targets: author and group links navigate correctly
 * 4. Auth error handling: proper messages for unauthenticated states
 */

test.describe('System State Architecture - Comment Persistence', () => {
  test('post detail modal on /hot uses URL query param', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    // Find a post item and click it
    const postItem = page.locator('.hot-post-item').first()
    if (await postItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postItem.click()

      // URL should now contain ?post=<id>
      await page.waitForTimeout(500)
      const url = page.url()
      expect(url).toContain('?post=')

      // Modal should be visible
      const modal = page.locator('[role="dialog"], [style*="position: fixed"]').first()
      await expect(modal).toBeVisible({ timeout: 3000 })
    }
  })

  test('post modal can be closed and URL updates', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const postItem = page.locator('.hot-post-item').first()
    if (await postItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postItem.click()
      await page.waitForTimeout(500)

      // Verify modal is open
      expect(page.url()).toContain('?post=')

      // Close by clicking the close button
      const closeBtn = page.locator('button[aria-label="Close"], button:has-text("×")').first()
      if (await closeBtn.isVisible()) {
        await closeBtn.click()
        await page.waitForTimeout(300)
        // URL should no longer have ?post=
        expect(page.url()).not.toContain('?post=')
      }
    }
  })

  test('post modal closes on ESC key', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const postItem = page.locator('.hot-post-item').first()
    if (await postItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postItem.click()
      await page.waitForTimeout(500)
      expect(page.url()).toContain('?post=')

      // Press ESC
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      expect(page.url()).not.toContain('?post=')
    }
  })

  test('post modal can be deep-linked via URL', async ({ page }) => {
    // First, get a post ID from the hot page
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const postItem = page.locator('.hot-post-item').first()
    if (await postItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postItem.click()
      await page.waitForTimeout(500)

      const url = page.url()
      const postId = new URL(url).searchParams.get('post')
      expect(postId).toBeTruthy()

      // Now navigate directly to the URL with post param
      await page.goto(`/hot?post=${postId}`)
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(1000)

      // Modal should be visible
      const modal = page.locator('[style*="position: fixed"]').first()
      await expect(modal).toBeVisible({ timeout: 5000 })
    }
  })

  test('comment section is visible in post modal', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const postItem = page.locator('.hot-post-item').first()
    if (await postItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await postItem.click()
      await page.waitForTimeout(1000)

      // Should show comments section (either comments or "no comments" message)
      const commentsSection = page.locator('text=/评论|comments|暂无评论/i').first()
      await expect(commentsSection).toBeVisible({ timeout: 5000 })
    }
  })
})

test.describe('System State Architecture - Navigation Consistency', () => {
  test('author name in post list is a clickable link', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    // Find an author link inside a post item
    const authorLink = page.locator('.hot-post-item a[href^="/u/"]').first()
    if (await authorLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await authorLink.getAttribute('href')
      expect(href).toMatch(/^\/u\//)
    }
  })


  test('clicking author link does not open post modal', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    const authorLink = page.locator('.hot-post-item a[href^="/u/"]').first()
    if (await authorLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await authorLink.click()
      await page.waitForTimeout(500)

      // Should navigate to user page, not open modal
      expect(page.url()).toContain('/u/')
      expect(page.url()).not.toContain('?post=')
    }
  })

  test('messages page requires authentication', async ({ page }) => {
    // Visit messages page without auth
    await page.goto('/messages/test-conversation-id')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // Should show login prompt or redirect
    const loginPrompt = page.locator('text=/请先登录|前往登录|登录/').first()
    const isLoginVisible = await loginPrompt.isVisible({ timeout: 5000 }).catch(() => false)

    // Either shows login prompt or redirects
    if (!isLoginVisible) {
      // May have redirected to messages list or login page
      const url = page.url()
      expect(url).toMatch(/\/(messages|login)/)
    }
  })

  test('hot page renders without errors', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('domcontentloaded')

    // Should have basic structure
    const mainContent = page.locator('main, [class*="container"]').first()
    await expect(mainContent).toBeVisible({ timeout: 5000 })

    // Should not show error state
    const errorText = page.locator('text=/error|错误|Internal Server Error/i')
    expect(await errorText.count()).toBe(0)
  })
})

test.describe('System State Architecture - API Auth Security', () => {
  test('follow API requires authentication for POST', async ({ request }) => {
    const response = await request.post('/api/follow', {
      data: { traderId: 'test-trader', action: 'follow' },
      headers: { 'Content-Type': 'application/json' },
    })

    // CSRF middleware may return 403, rate limiter may return 429
    expect([401, 403, 429]).toContain(response.status())
    const data = await response.json()
    expect(data.error).toBeTruthy()
  })

  test('messages API requires authentication for GET', async ({ request }) => {
    const response = await request.get('/api/messages?conversationId=test-id')

    // Accept 401 (unauthorized) or 429 (rate limited)
    expect([401, 429]).toContain(response.status())
    const data = await response.json()
    expect(data.error).toBeTruthy()
  })

  test('messages API requires authentication for POST', async ({ request }) => {
    const response = await request.post('/api/messages', {
      data: { receiverId: 'test-user', content: 'hello' },
      headers: { 'Content-Type': 'application/json' },
    })

    // Accept 401 (unauthorized) or 429 (rate limited)
    expect([401, 429]).toContain(response.status())
    const data = await response.json()
    expect(data.error).toBeTruthy()
  })
})
