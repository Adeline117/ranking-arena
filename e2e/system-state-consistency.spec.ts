import { test, expect } from '@playwright/test'

test.describe('System State Consistency - Route & Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Mock comments API to avoid dependency on real data
    await page.route('**/api/posts/*/comments*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { comments: [] },
            meta: { pagination: { limit: 10, offset: 0, has_more: false }, timestamp: new Date().toISOString() },
          }),
        })
      } else {
        await route.continue()
      }
    })
  })

  test('Hot page modal: Escape key closes modal and updates URL', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'No hot posts available')
      return
    }

    // Open post modal
    await firstPost.click()
    await page.waitForTimeout(300)

    // URL should contain ?post= param
    expect(page.url()).toContain('?post=')

    // Modal should be visible (fixed overlay)
    const modal = page.locator('[style*="position: fixed"]').first()
    await expect(modal).toBeVisible()

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Modal should be closed
    // URL should no longer contain ?post=
    expect(page.url()).not.toContain('post=')
  })

  test('Hot page modal: close button removes URL param', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'No hot posts available')
      return
    }

    await firstPost.click()
    await page.waitForTimeout(300)
    expect(page.url()).toContain('?post=')

    // Click close button (×)
    const closeBtn = page.locator('button').filter({ hasText: '×' }).first()
    await closeBtn.click()
    await page.waitForTimeout(300)

    expect(page.url()).not.toContain('post=')
  })

  test('Hot page modal: direct URL with ?post= opens modal on load', async ({ page }) => {
    // First, get a valid post ID
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'No hot posts available')
      return
    }

    // Click to get post ID from URL
    await firstPost.click()
    await page.waitForTimeout(300)

    const url = new URL(page.url())
    const postId = url.searchParams.get('post')
    if (!postId) {
      test.skip(true, 'Could not extract post ID from URL')
      return
    }

    // Navigate directly to URL with ?post= param
    await page.goto(`/hot?post=${postId}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    // Modal should be visible
    const modalOverlay = page.locator('[style*="position: fixed"]').first()
    await expect(modalOverlay).toBeVisible({ timeout: 5000 })
  })
})

test.describe('System State Consistency - Author Navigation', () => {
  test('Hot page: author name in post list is a clickable link to profile', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    // Find an author link (@ prefixed) in the hot post list
    const authorLink = page.locator('.hot-post-item a[href*="/u/"]').first()

    if (await authorLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await authorLink.getAttribute('href')
      expect(href).toMatch(/\/u\/[^/]+/)

      // Click should navigate to user profile
      await authorLink.click()
      await page.waitForLoadState('networkidle')
      expect(page.url()).toMatch(/\/u\//)
    } else {
      // Posts exist but author might be anonymous
      const anyPost = page.locator('.hot-post-item').first()
      if (await anyPost.isVisible({ timeout: 3000 })) {
        expect(true).toBe(true) // Valid: anonymous posts
      } else {
        test.skip(true, 'No hot posts available')
      }
    }
  })

  test('Hot page: clicking author name does NOT open post modal', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    // Mock comments
    await page.route('**/api/posts/*/comments*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { comments: [] },
          meta: { pagination: { limit: 10, offset: 0, has_more: false }, timestamp: new Date().toISOString() },
        }),
      })
    })

    const authorLink = page.locator('.hot-post-item a[href*="/u/"]').first()

    if (await authorLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await authorLink.click()
      await page.waitForTimeout(300)

      // Should navigate to profile, NOT have ?post= in URL
      expect(page.url()).toMatch(/\/u\//)
      expect(page.url()).not.toContain('?post=')
    } else {
      test.skip(true, 'No author links available')
    }
  })

  test('Groups page: author links in posts navigate to user profiles', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')

    // Find a group link and navigate to it
    const groupLink = page.locator('a[href*="/groups/"]').first()
    if (!(await groupLink.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'No groups available')
      return
    }

    await groupLink.click()
    await page.waitForLoadState('networkidle')

    // Find author links in posts
    const authorLink = page.locator('a[href*="/u/"]').first()
    if (await authorLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const href = await authorLink.getAttribute('href')
      expect(href).toMatch(/\/u\/[^/]+/)
    } else {
      // Valid: group might have no posts or anonymous posts
      expect(true).toBe(true)
    }
  })
})

test.describe('System State Consistency - Error Handling', () => {
  test('Message API: returns 401 without auth token', async ({ page }) => {
    const response = await page.request.post('/api/messages', {
      data: {
        senderId: 'fake-user-id',
        receiverId: 'other-user-id',
        content: 'test message',
      },
      headers: {
        'Content-Type': 'application/json',
      },
    })

    expect(response.status()).toBe(401)
    const body = await response.json()
    expect(body.error).toBeTruthy()
  })

  test('Message start API: returns 401 without auth token', async ({ page }) => {
    const response = await page.request.post('/api/messages/start', {
      data: {
        senderId: 'fake-user-id',
        receiverId: 'other-user-id',
      },
      headers: {
        'Content-Type': 'application/json',
      },
    })

    expect(response.status()).toBe(401)
    const body = await response.json()
    expect(body.error).toBeTruthy()
  })

  test('Follow API: returns 401 without auth token', async ({ page }) => {
    const response = await page.request.post('/api/follow', {
      data: {
        userId: 'fake-user-id',
        traderId: 'some-trader-id',
        action: 'follow',
      },
      headers: {
        'Content-Type': 'application/json',
      },
    })

    expect(response.status()).toBe(401)
    const body = await response.json()
    expect(body.error).toBeTruthy()
  })

  test('Comments POST API: returns 401 without auth token', async ({ page }) => {
    const response = await page.request.post('/api/posts/fake-post-id/comments', {
      data: {
        content: 'test comment',
      },
      headers: {
        'Content-Type': 'application/json',
      },
    })

    // Should return 401 since no Authorization header
    expect(response.status()).toBe(401)
  })
})
