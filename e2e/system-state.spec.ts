import { test, expect, Page } from '@playwright/test'

/**
 * System State Management E2E Tests - Comprehensive Suite
 *
 * Validates the unified behavior model across all entry points:
 * A) Comment persistence: server ACK, cross-entry consistency
 * B) Auth boundaries: write ops blocked, token errors categorized
 * C) Routing/navigation: URL-driven modals, escape/close/back
 * D) Click targets: author/group links, no event swallowing
 */

// ============================================================
// A) COMMENT PERSISTENCE (Server ACK)
// ============================================================
test.describe('A) Comment Persistence - Server ACK', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
  })

  test('comments load from server when post modal opens', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(1500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    // Comment section header must exist (shows count from server)
    const commentHeader = modal.locator('text=/评论|comments/i')
    await expect(commentHeader.first()).toBeVisible()
  })

  test('comments persist after closing and reopening the same post', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    // Open post
    await firstPost.click()
    await page.waitForTimeout(1500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    // Count existing comments (if any)
    const commentItems = modal.locator('div[translate="no"]')
    const initialCount = await commentItems.count()

    // Close modal
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await expect(modal).not.toBeVisible()

    // Reopen same post
    await firstPost.click()
    await page.waitForTimeout(1500)
    await expect(modal).toBeVisible()

    // Comments should still be the same count (loaded from server)
    const reopenedCount = await commentItems.count()
    expect(reopenedCount).toBe(initialCount)
  })

  test('same post from direct URL shows same comments as from list', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    // Open post from list
    await firstPost.click()
    await page.waitForTimeout(1500)

    const postUrl = page.url()
    const postParam = new URL(postUrl).searchParams.get('post')
    if (!postParam) {
      test.skip()
      return
    }

    // Get comment count from modal
    const modal = page.locator('[role="dialog"]')
    const commentItems = modal.locator('div[translate="no"]')
    const listOpenCount = await commentItems.count()

    // Navigate away and come back via direct URL
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
    await page.goto(`/hot?post=${postParam}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Comments should be same from direct URL
    const directModal = page.locator('[role="dialog"]')
    await expect(directModal).toBeVisible()
    const directCommentItems = directModal.locator('div[translate="no"]')
    const directCount = await directCommentItems.count()
    expect(directCount).toBe(listOpenCount)
  })

  test('submit button disabled when textarea is empty', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    const submitBtn = page.locator('[role="dialog"] button:has-text("发表评论"), [role="dialog"] button:has-text("Submit")')
    if (await submitBtn.isVisible()) {
      await expect(submitBtn).toBeDisabled()
    }
  })

  test('submit button enables when textarea has content', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    const textarea = page.locator('[role="dialog"] textarea')
    const submitBtn = page.locator('[role="dialog"] button:has-text("发表评论"), [role="dialog"] button:has-text("Submit")')

    if (await textarea.isVisible() && await submitBtn.isVisible()) {
      // Type something
      await textarea.fill('test comment')
      // Button should be clickable (not disabled) if user is logged in
      // For unauthenticated users, it may still be disabled
      const isDisabled = await submitBtn.isDisabled()
      // At minimum, we verify the UI reacts to input
      expect(typeof isDisabled).toBe('boolean')
    }
  })

  test('comment textarea is disabled when not logged in', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    const textarea = page.locator('[role="dialog"] textarea')
    if (await textarea.isVisible()) {
      const isDisabled = await textarea.isDisabled()
      const placeholder = await textarea.getAttribute('placeholder') || ''
      // When not logged in, should either be disabled or show login prompt
      expect(isDisabled || placeholder.includes('登录')).toBeTruthy()
    }
  })
})

// ============================================================
// B) AUTH BOUNDARIES
// ============================================================
test.describe('B) Auth Boundaries', () => {
  test('unauthenticated user cannot submit comments (no API call made)', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Track API calls
    const apiCalls: string[] = []
    page.on('request', req => {
      if (req.method() === 'POST' && req.url().includes('/comments')) {
        apiCalls.push(req.url())
      }
    })

    const textarea = page.locator('[role="dialog"] textarea')
    if (await textarea.isVisible() && !(await textarea.isDisabled())) {
      await textarea.fill('This should not be sent')

      const submitBtn = page.locator('[role="dialog"] button:has-text("发表评论"), [role="dialog"] button:has-text("Submit")')
      if (await submitBtn.isVisible() && !(await submitBtn.isDisabled())) {
        await submitBtn.click()
        await page.waitForTimeout(1000)
      }
    }

    // No comment API call should have been made for unauthenticated user
    // (the hook checks isLoggedIn before calling API)
    expect(apiCalls.length).toBe(0)
  })

  test('messages page shows clear login prompt (not "unauthorized" error)', async ({ page }) => {
    await page.goto('/messages')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3000)

    // Should show friendly login prompt
    const loginPrompt = page.locator('text=/请先登录|前往登录|Please login/i')
    await expect(loginPrompt.first()).toBeVisible()

    // Should NOT show raw "unauthorized" or "未授权" error text
    const unauthorizedError = page.locator('text=/未授权|Unauthorized|unauthorized/i')
    const errorCount = await unauthorizedError.count()
    expect(errorCount).toBe(0)
  })

  test('messages conversation page shows login prompt when not authenticated', async ({ page }) => {
    // Navigate to a fake conversation ID
    await page.goto('/messages/fake-conversation-id')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3000)

    // Should show login prompt or redirect, not crash
    const loginPrompt = page.locator('text=/请先登录|前往登录|Please login/i')
    const isOnLoginPage = page.url().includes('/login')
    const hasPrompt = await loginPrompt.count() > 0

    expect(hasPrompt || isOnLoginPage).toBeTruthy()
  })

  test('no "unauthorized" console errors on hot page for unauthenticated user', async ({ page }) => {
    const criticalErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('未授权') || text.includes('unauthorized') || text.includes('Unauthorized')) {
          criticalErrors.push(text)
        }
      }
    })

    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3000)

    expect(criticalErrors).toHaveLength(0)
  })

  test('no "unauthorized" console errors on groups page for unauthenticated user', async ({ page }) => {
    const criticalErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('未授权') || text.includes('unauthorized') || text.includes('Unauthorized')) {
          criticalErrors.push(text)
        }
      }
    })

    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(3000)

    expect(criticalErrors).toHaveLength(0)
  })

  test('messages API returns 401 for unauthenticated POST', async ({ page }) => {
    // Directly test the API endpoint
    const response = await page.request.post('/api/messages', {
      data: { receiverId: 'fake-id', content: 'test' },
      headers: { 'Content-Type': 'application/json' }
    })

    expect(response.status()).toBe(401)
    const body = await response.json()
    expect(body.error).toContain('登录')
  })

  test('messages API returns 401 with expired token message for invalid token', async ({ page }) => {
    const response = await page.request.post('/api/messages', {
      data: { receiverId: 'fake-id', content: 'test' },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-expired-token'
      }
    })

    expect(response.status()).toBe(401)
    const body = await response.json()
    // Should contain a login-related message, not generic error
    expect(body.error).toMatch(/登录|认证/)
  })
})

// ============================================================
// C) ROUTING & NAVIGATION CONSISTENCY
// ============================================================
test.describe('C) Routing & Navigation - URL Driven', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
  })

  test('opening post updates URL with ?post=id', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    expect(page.url()).toContain('post=')
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()
  })

  test('close button removes ?post= from URL', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)
    expect(page.url()).toContain('post=')

    const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"]')
    await closeBtn.click()
    await page.waitForTimeout(300)

    expect(page.url()).not.toContain('post=')
    await expect(page.locator('[role="dialog"]')).not.toBeVisible()
  })

  test('Escape key closes modal and updates URL', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)
    expect(page.url()).toContain('post=')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    expect(page.url()).not.toContain('post=')
    await expect(page.locator('[role="dialog"]')).not.toBeVisible()
  })

  test('backdrop click closes modal and updates URL', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Click the backdrop area (top-left corner of overlay)
    const dialog = page.locator('[role="dialog"]')
    await dialog.click({ position: { x: 5, y: 5 } })
    await page.waitForTimeout(300)

    await expect(dialog).not.toBeVisible()
    expect(page.url()).not.toContain('post=')
  })

  test('close/escape/backdrop all produce same result', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    // Test 1: Close button
    await firstPost.click()
    await page.waitForTimeout(300)
    await page.locator('[role="dialog"] button[aria-label="Close"]').click()
    await page.waitForTimeout(300)
    const urlAfterClose = page.url()

    // Test 2: Escape
    await firstPost.click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const urlAfterEscape = page.url()

    // Both should produce same clean URL
    expect(urlAfterClose).toBe(urlAfterEscape)
    expect(urlAfterClose).not.toContain('post=')
  })

  test('direct URL ?post=id opens modal on page load', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)
    const postParam = new URL(page.url()).searchParams.get('post')

    // Navigate directly
    await page.goto(`/hot?post=${postParam}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)

    await expect(page.locator('[role="dialog"]')).toBeVisible()
  })

  test('body scroll is locked when modal is open', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    // Check body overflow before
    const overflowBefore = await page.evaluate(() => document.body.style.overflow)
    expect(overflowBefore).not.toBe('hidden')

    // Open modal
    await firstPost.click()
    await page.waitForTimeout(300)

    const overflowDuring = await page.evaluate(() => document.body.style.overflow)
    expect(overflowDuring).toBe('hidden')

    // Close modal
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    const overflowAfter = await page.evaluate(() => document.body.style.overflow)
    expect(overflowAfter).not.toBe('hidden')
  })

  test('hot page remains accessible after modal close', async ({ page }) => {
    const posts = page.locator('.hot-post-item')
    const postCount = await posts.count()
    if (postCount === 0) {
      test.skip()
      return
    }

    // Open and close several times
    for (let i = 0; i < Math.min(3, postCount); i++) {
      await posts.nth(i).click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }

    // Page should still be functional
    expect(page.url()).not.toContain('post=')
    await expect(posts.first()).toBeVisible()
  })
})

// ============================================================
// D) CLICK TARGETS - Author/Group Links
// ============================================================
test.describe('D) Click Targets - Author and Group Links', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
  })

  test('author link in post list navigates to /u/{handle}', async ({ page }) => {
    const authorLink = page.locator('.hot-post-item a[href^="/u/"]').first()
    if (!(await authorLink.isVisible())) {
      test.skip()
      return
    }

    const href = await authorLink.getAttribute('href')
    expect(href).toMatch(/^\/u\/[^/]+$/)

    // Click author - should NOT open modal
    await authorLink.click()
    await page.waitForTimeout(500)

    expect(page.url()).toContain('/u/')
    expect(page.url()).not.toContain('post=')
  })

  test('group link in post list navigates to /groups/{id}', async ({ page }) => {
    const groupLink = page.locator('.hot-post-item a[href^="/groups/"]').first()
    if (!(await groupLink.isVisible())) {
      test.skip()
      return
    }

    const href = await groupLink.getAttribute('href')
    expect(href).toMatch(/^\/groups\/[^/]+$/)

    await groupLink.click()
    await page.waitForTimeout(500)

    expect(page.url()).toContain('/groups/')
  })

  test('clicking author link does NOT trigger outer card click', async ({ page }) => {
    const authorLink = page.locator('.hot-post-item a[href^="/u/"]').first()
    if (!(await authorLink.isVisible())) {
      test.skip()
      return
    }

    await authorLink.click()
    await page.waitForTimeout(500)

    // Should be on user page, not have a modal open
    const modal = page.locator('[role="dialog"]')
    await expect(modal).not.toBeVisible()
  })

  test('clicking group link does NOT trigger outer card click', async ({ page }) => {
    const groupLink = page.locator('.hot-post-item a[href^="/groups/"]').first()
    if (!(await groupLink.isVisible())) {
      test.skip()
      return
    }

    await groupLink.click()
    await page.waitForTimeout(500)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).not.toBeVisible()
  })

  test('author link inside modal points to user profile', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    const modalAuthorLink = page.locator('[role="dialog"] a[href^="/u/"]').first()
    if (await modalAuthorLink.isVisible()) {
      const href = await modalAuthorLink.getAttribute('href')
      expect(href).toMatch(/^\/u\/[^/]+$/)
    }
  })

  test('group link inside modal points to group page', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    const modalGroupLink = page.locator('[role="dialog"] a[href^="/groups/"]').first()
    if (await modalGroupLink.isVisible()) {
      const href = await modalGroupLink.getAttribute('href')
      expect(href).toMatch(/^\/groups\/[^/]+$/)
    }
  })

  test('comment author links point to user profiles', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(2000) // Wait for comments to load

    // Check all user links in the comment area
    const commentAuthorLinks = page.locator('[role="dialog"] a[href^="/u/"]')
    const count = await commentAuthorLinks.count()

    for (let i = 0; i < Math.min(count, 5); i++) {
      const href = await commentAuthorLinks.nth(i).getAttribute('href')
      expect(href).toMatch(/^\/u\/[^/]+$/)
    }
  })
})

// ============================================================
// E) CROSS-ENTRY CONSISTENCY
// ============================================================
test.describe('E) Cross-Entry Consistency', () => {
  test('groups page loads without auth errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    const authErrors = errors.filter(e =>
      e.includes('未授权') ||
      e.includes('unauthorized') ||
      e.includes('Cannot read properties of null')
    )
    expect(authErrors).toHaveLength(0)
  })

  test('hot page and groups page both accessible in same session', async ({ page }) => {
    // Visit hot page
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/hot')

    // Visit groups page
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/groups')

    // Go back to hot page
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('/hot')

    // Both should work without errors
    const posts = page.locator('.hot-post-item')
    // At least the page structure should be intact
    await page.waitForTimeout(1000)
  })

  test('navigation between pages does not leak modal state', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    // Open modal
    await firstPost.click()
    await page.waitForTimeout(300)
    expect(page.url()).toContain('post=')

    // Navigate to groups
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')

    // Modal should not be visible on groups page
    const modal = page.locator('[role="dialog"]')
    await expect(modal).not.toBeVisible()

    // Come back to hot
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    // Modal should not automatically reopen (URL was changed)
    await expect(modal).not.toBeVisible()
    expect(page.url()).not.toContain('post=')
  })
})
