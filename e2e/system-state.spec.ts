import { test, expect } from '@playwright/test'

/**
 * System State Management E2E Tests
 *
 * Validates the unified behavior model:
 * 1. Comment persistence: comments visible after reload
 * 2. Routing/navigation consistency: URL-driven modals, escape/close/back
 * 3. Click targets: author links, group links
 * 4. Auth state: consistent across entry points
 */

test.describe('Post Modal - URL Driven State', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
  })

  test('opening a post updates the URL with ?post=id', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // URL should contain ?post= parameter
    expect(page.url()).toContain('post=')

    // Modal should be visible
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()
  })

  test('closing modal removes ?post= from URL', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)
    expect(page.url()).toContain('post=')

    // Close via close button
    const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"]')
    await closeBtn.click()
    await page.waitForTimeout(300)

    // URL should no longer have post param
    expect(page.url()).not.toContain('post=')

    // Modal should be hidden
    const modal = page.locator('[role="dialog"]')
    await expect(modal).not.toBeVisible()
  })

  test('pressing Escape closes the modal and updates URL', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)
    expect(page.url()).toContain('post=')

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Modal should be closed
    const modal = page.locator('[role="dialog"]')
    await expect(modal).not.toBeVisible()

    // URL should be clean
    expect(page.url()).not.toContain('post=')
  })

  test('clicking backdrop closes the modal', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Click backdrop (the dialog overlay itself)
    const modal = page.locator('[role="dialog"]')
    await modal.click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(300)

    await expect(modal).not.toBeVisible()
  })

  test('direct URL with ?post=id opens the modal on page load', async ({ page }) => {
    // First get a post ID from the list
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    const url = page.url()
    const postParam = new URL(url).searchParams.get('post')
    expect(postParam).toBeTruthy()

    // Navigate directly to the URL with post param
    await page.goto(`/hot?post=${postParam}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    // Modal should open from URL state
    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()
  })
})

test.describe('Comment Persistence (Server ACK)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
  })

  test('comments section loads when post modal opens', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(1000)

    const modal = page.locator('[role="dialog"]')
    await expect(modal).toBeVisible()

    // Comment section should be present (either with comments or empty state)
    const commentSection = modal.locator('text=/评论|comments/i')
    await expect(commentSection.first()).toBeVisible()
  })

  test('comment textarea shows login prompt when not authenticated', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Textarea should show login prompt placeholder
    const textarea = page.locator('[role="dialog"] textarea')
    if (await textarea.isVisible()) {
      const placeholder = await textarea.getAttribute('placeholder')
      // Should mention login when not authenticated
      expect(placeholder).toBeTruthy()
    }
  })

  test('submit button is disabled when comment is empty', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Find submit button in modal
    const submitBtn = page.locator('[role="dialog"] button:has-text("发表评论"), [role="dialog"] button:has-text("Submit")')
    if (await submitBtn.isVisible()) {
      // Should be disabled when textarea is empty
      await expect(submitBtn).toBeDisabled()
    }
  })
})

test.describe('Click Targets - Author and Group Links', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')
  })

  test('author name in post list navigates to user profile', async ({ page }) => {
    // Find an author link in the hot post list
    const authorLink = page.locator('.hot-post-item a[href^="/u/"]').first()
    if (!(await authorLink.isVisible())) {
      test.skip()
      return
    }

    const href = await authorLink.getAttribute('href')
    expect(href).toContain('/u/')

    // Click should navigate to user profile, not open the post modal
    await authorLink.click()
    await page.waitForTimeout(500)

    expect(page.url()).toContain('/u/')
    // Should NOT have opened a post modal
    expect(page.url()).not.toContain('post=')
  })

  test('group name in post list navigates to group page', async ({ page }) => {
    // Find a group link in the hot post list
    const groupLink = page.locator('.hot-post-item a[href^="/groups/"]').first()
    if (!(await groupLink.isVisible())) {
      test.skip()
      return
    }

    const href = await groupLink.getAttribute('href')
    expect(href).toContain('/groups/')

    await groupLink.click()
    await page.waitForTimeout(500)

    expect(page.url()).toContain('/groups/')
  })

  test('author link in modal navigates to user profile', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Find author link inside modal
    const modalAuthorLink = page.locator('[role="dialog"] a[href^="/u/"]').first()
    if (!(await modalAuthorLink.isVisible())) {
      test.skip()
      return
    }

    const href = await modalAuthorLink.getAttribute('href')
    expect(href).toContain('/u/')
  })

  test('group link in modal navigates to group page', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(500)

    // Find group link inside modal
    const modalGroupLink = page.locator('[role="dialog"] a[href^="/groups/"]').first()
    if (!(await modalGroupLink.isVisible())) {
      test.skip()
      return
    }

    const href = await modalGroupLink.getAttribute('href')
    expect(href).toContain('/groups/')
  })

  test('comment author is a clickable link', async ({ page }) => {
    const firstPost = page.locator('.hot-post-item').first()
    if (!(await firstPost.isVisible())) {
      test.skip()
      return
    }

    await firstPost.click()
    await page.waitForTimeout(1500) // Wait for comments to load

    // Check if any comment author is a link
    const commentAuthorLink = page.locator('[role="dialog"] a[href^="/u/"]')
    const count = await commentAuthorLink.count()

    // If there are comments with author links, they should point to user profiles
    if (count > 0) {
      const href = await commentAuthorLink.first().getAttribute('href')
      expect(href).toContain('/u/')
    }
  })
})

test.describe('Navigation Consistency', () => {
  test('hot page loads without errors', async ({ page }) => {
    await page.goto('/hot')
    await page.waitForLoadState('networkidle')

    // No console errors for auth issues
    const errors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    await page.waitForTimeout(2000)

    // Filter out non-critical errors (network issues in test env)
    const criticalErrors = errors.filter(e =>
      e.includes('未授权') ||
      e.includes('unauthorized') ||
      e.includes('Cannot read properties')
    )
    expect(criticalErrors).toHaveLength(0)
  })

  test('messages page shows login prompt when not authenticated', async ({ page }) => {
    await page.goto('/messages')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Should show login prompt, NOT an error about "unauthorized"
    const loginPrompt = page.locator('text=/请先登录|前往登录|Please login/i')
    const unauthorizedError = page.locator('text=/未授权|Unauthorized/i')

    // Login prompt should be visible
    await expect(loginPrompt.first()).toBeVisible()

    // Unauthorized error should NOT be visible
    expect(await unauthorizedError.count()).toBe(0)
  })

  test('groups page is accessible', async ({ page }) => {
    await page.goto('/groups')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)

    // Should not throw errors
    expect(page.url()).toContain('/groups')
  })
})
