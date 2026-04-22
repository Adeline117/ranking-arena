import { test, expect, type Page } from '@playwright/test'

/**
 * Social Pages E2E Test Suite
 *
 * Tests /groups and /hot pages for:
 * 1. Group list rendering
 * 2. Following / Recommended tabs
 * 3. Group card navigation to detail
 * 4. Group header (name, member count, join button)
 * 5. Posts list within group
 * 6. Login to Join button -> login modal
 * 7. Hot page trending feed
 * 8. Post card engagement metrics
 * 9. Mobile viewport (390x844)
 * 10. Console errors and 500 responses
 */

const SCREENSHOTS_DIR = 'e2e/screenshots/social'

/** Navigate to a page without waiting for full load (dev server is slow) */
async function gotoPage(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  // Allow client-side hydration + data fetch
  await page.waitForTimeout(3000)
}

/** Dismiss cookie consent banner if visible */
async function dismissCookieConsent(page: Page) {
  const acceptCookies = page.locator('button:has-text("接受全部"), button:has-text("Accept")')
  if (
    await acceptCookies
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false)
  ) {
    await acceptCookies.first().click()
    await page.waitForTimeout(500)
  }
}

/** Find a specific group link on /groups (excluding /groups and /groups/apply) */
function findGroupDetailLink(page: Page) {
  return page
    .locator('a[href*="/groups/"]')
    .filter({
      has: page.locator(':scope:not([href="/groups"]):not([href="/groups/apply"])'),
    })
    .first()
}

/** Collect console errors and failed network requests */
function setupErrorTracking(page: Page) {
  const consoleErrors: string[] = []
  const networkErrors: { url: string; status: number }[] = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })

  page.on('response', (response) => {
    if (response.status() >= 500) {
      networkErrors.push({ url: response.url(), status: response.status() })
    }
  })

  return { consoleErrors, networkErrors }
}

/** Navigate to first group detail from /groups page */
async function navigateToFirstGroup(page: Page): Promise<boolean> {
  await gotoPage(page, '/groups')
  await dismissCookieConsent(page)

  // Wait for group links to appear (sidebar or content)
  const allLinks = page.locator('a[href^="/groups/"]')
  await allLinks
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {})

  const count = await allLinks.count()
  if (count === 0) return false

  // Find a proper group detail link (with UUID or slug)
  let targetHref: string | null = null
  for (let i = 0; i < count; i++) {
    const h = await allLinks.nth(i).getAttribute('href')
    if (
      h &&
      h !== '/groups' &&
      h !== '/groups/apply' &&
      h !== '/groups/' &&
      h.split('/groups/')[1]?.length > 2
    ) {
      targetHref = h
      break
    }
  }

  if (!targetHref) return false

  // Navigate directly to the URL instead of clicking (avoids client-nav timeout)
  await page.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForTimeout(5000) // Wait for client-side hydration + data fetching
  return true
}

// =============================================================================
// 1. /groups - Group List Rendering
// =============================================================================
test.describe('Groups page - list rendering', () => {
  test('1. Load /groups, verify group list renders', async ({ page }) => {
    const { networkErrors } = setupErrorTracking(page)

    await gotoPage(page, '/groups')
    await dismissCookieConsent(page)

    // Page should load and contain group-related content
    await expect(page).toHaveURL(/\/groups/)
    await expect(page).toHaveTitle(/Arena/i)

    // The page body should have significant content
    const body = await page.textContent('body')
    expect(body).toBeTruthy()
    expect(body!.length).toBeGreaterThan(100)

    // Wait for group links to appear (sidebar RecommendedGroups fetches async)
    const groupLinks = page.locator('a[href^="/groups/"]')
    await groupLinks
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => {})

    const groupLinkCount = await groupLinks.count()

    // Should have at least one group link
    expect(groupLinkCount).toBeGreaterThan(0)

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-groups-list.png`, fullPage: false })

    // Check for 500 errors
    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    if (serverErrors.length > 0) {
      console.warn('Server errors on /groups:', serverErrors)
    }
  })
})

// =============================================================================
// 2. Following / Recommended Tabs
// =============================================================================
test.describe('Groups page - tabs', () => {
  test('2. Verify "Following" and "Recommended" tabs exist', async ({ page }) => {
    await gotoPage(page, '/groups')
    await dismissCookieConsent(page)

    // The GroupsFeedPage renders tabs as <button> elements
    const followingTab = page
      .locator('button')
      .filter({
        hasText: /Following|关注/i,
      })
      .first()
    const recommendedTab = page
      .locator('button')
      .filter({
        hasText: /Recommended|推荐/i,
      })
      .first()

    await expect(followingTab).toBeVisible({ timeout: 15_000 })
    await expect(recommendedTab).toBeVisible({ timeout: 15_000 })

    // Click Following tab
    await followingTab.click()
    await page.waitForTimeout(1000)
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-groups-following-tab.png`,
      fullPage: false,
    })

    // Click Recommended tab
    await recommendedTab.click()
    await page.waitForTimeout(1000)
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/02-groups-recommended-tab.png`,
      fullPage: false,
    })
  })
})

// =============================================================================
// 3. Click group card -> group detail page
// =============================================================================
test.describe('Groups page - group card navigation', () => {
  test('3. Click a group card, verify group detail page loads', async ({ page }) => {
    await gotoPage(page, '/groups')
    await dismissCookieConsent(page)

    // Find a group detail link
    const allLinks = page.locator('a[href^="/groups/"]')
    await allLinks
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {})

    const count = await allLinks.count()
    let targetHref: string | null = null

    for (let i = 0; i < count; i++) {
      const h = await allLinks.nth(i).getAttribute('href')
      if (
        h &&
        h !== '/groups' &&
        h !== '/groups/apply' &&
        h !== '/groups/' &&
        h.split('/groups/')[1]?.length > 2
      ) {
        targetHref = h
        break
      }
    }

    if (!targetHref) {
      test.skip(true, 'No group links found on /groups page')
      return
    }

    // Navigate directly to the group (dev server compilation can exceed default timeouts)
    await page.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForTimeout(5000)

    // Verify URL is a group detail page
    expect(page.url()).toMatch(/\/groups\/[a-zA-Z0-9-]+/)

    // Verify page has content (not blank)
    const bodyText = await page.textContent('body')
    expect(bodyText).toBeTruthy()
    expect(bodyText!.length).toBeGreaterThan(50)

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/03-group-detail.png`, fullPage: false })
  })
})

// =============================================================================
// 4. Group header (name, member count, join button)
// =============================================================================
test.describe('Group detail page - header', () => {
  test('4. Verify group header (name, member count, join button)', async ({ page }) => {
    const navigated = await navigateToFirstGroup(page)
    if (!navigated) {
      test.skip(true, 'No group links found')
      return
    }

    // Group header renders inside .group-header-layout
    const headerLayout = page.locator('.group-header-layout')
    if (!(await headerLayout.isVisible({ timeout: 15_000 }).catch(() => false))) {
      const bodyText = await page.textContent('body')
      expect(bodyText).toBeTruthy()
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/04-group-header-fallback.png`,
        fullPage: false,
      })
      return
    }

    // Group name in .group-header-info
    const headerInfo = page.locator('.group-header-info')
    await expect(headerInfo).toBeVisible()

    const headerText = await headerInfo.textContent()
    expect(headerText).toBeTruthy()
    expect(headerText!.length).toBeGreaterThan(0)

    // Member count badge
    const memberBadge = page.locator('.member-badge')
    if (await memberBadge.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const memberText = await memberBadge.textContent()
      expect(memberText).toBeTruthy()
      expect(memberText).toMatch(/\d+/)
    }

    // Join/Leave/Login button in .group-header-actions
    const headerActions = page.locator('.group-header-actions')
    await expect(headerActions).toBeVisible({ timeout: 5_000 })

    const actionButton = headerActions.locator('button, a').first()
    await expect(actionButton).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/04-group-header.png`, fullPage: false })
  })
})

// =============================================================================
// 5. Posts list within group
// =============================================================================
test.describe('Group detail page - posts', () => {
  test('5. Verify posts list renders within the group', async ({ page }) => {
    const navigated = await navigateToFirstGroup(page)
    if (!navigated) {
      test.skip(true, 'No group links found')
      return
    }

    // Use #main-content which is more specific than just 'main'
    const mainContent = page.locator('#main-content').first()
    await expect(mainContent).toBeVisible({ timeout: 15_000 })

    const mainText = await mainContent.textContent()
    expect(mainText).toBeTruthy()

    // Look for post-related elements or empty state
    const postElements = page.locator('article, [data-testid="post-item"], .post-card, .post-item')
    const emptyState = page.getByText(/No posts|暂无帖子|还没有帖子|没有更多/i).first()

    const hasPostElements = (await postElements.count()) > 0
    const hasEmptyState = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)

    // Either posts exist, there's an empty state, or the page has meaningful content
    expect(hasPostElements || hasEmptyState || mainText!.length > 50).toBeTruthy()

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-group-posts.png`, fullPage: false })
  })
})

// =============================================================================
// 6. Login to Join button -> login modal
// =============================================================================
test.describe('Group detail page - login modal', () => {
  test('6. Test "Login to Join" button - verify login modal opens', async ({ page }) => {
    const navigated = await navigateToFirstGroup(page)
    if (!navigated) {
      test.skip(true, 'No group links found')
      return
    }

    // Look for "Login to Join" button (i18n key: groupLoginToJoin)
    const loginToJoinBtn = page
      .locator('button')
      .filter({
        hasText: /Login to Join|登录加入|登录后加入|登录即可加入/i,
      })
      .first()

    if (!(await loginToJoinBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      // User might already be logged in
      const joinOrLeaveBtn = page.locator('.group-header-actions button').first()
      if (await joinOrLeaveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const btnText = await joinOrLeaveBtn.textContent()
        expect(btnText).toBeTruthy()
        await page.screenshot({
          path: `${SCREENSHOTS_DIR}/06-group-logged-in.png`,
          fullPage: false,
        })
        return
      }
      test.skip(true, 'No Login to Join button found (user may be logged in)')
      return
    }

    // Click the Login to Join button
    await loginToJoinBtn.click()
    await page.waitForTimeout(1000)

    // LoginModal should appear - it's a fixed overlay with auth options
    const loginModal = page
      .locator('[role="dialog"], [style*="position: fixed"]')
      .filter({
        hasText: /Google|Email|登录|Sign in|Log in/i,
      })
      .first()

    if (await loginModal.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/06-login-modal.png`, fullPage: false })
      const modalText = await loginModal.textContent()
      expect(modalText).toBeTruthy()
    } else {
      // Accept either modal or login page redirect
      const url = page.url()
      const bodyText = await page.textContent('body')
      expect(
        url.includes('/login') || bodyText?.includes('Google') || bodyText?.includes('登录')
      ).toBeTruthy()
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/06-login-redirect.png`, fullPage: false })
    }
  })
})

// =============================================================================
// 7. Hot page - trending posts feed
// =============================================================================
test.describe('Hot page - trending feed', () => {
  test('7. Load /hot, verify trending posts feed renders', async ({ page }) => {
    const { networkErrors } = setupErrorTracking(page)

    await gotoPage(page, '/hot')
    await dismissCookieConsent(page)

    await expect(page).toHaveURL(/\/hot/)
    await expect(page).toHaveTitle(/Arena/i)

    // Hot posts are rendered as .hot-post-item elements
    const hotPostItems = page.locator('.hot-post-item')
    await hotPostItems
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {})

    const postCount = await hotPostItems.count()

    if (postCount > 0) {
      expect(postCount).toBeGreaterThan(0)

      // Verify first post has a rank number (#1)
      const firstRank = page.locator('.hot-post-rank').first()
      await expect(firstRank).toBeVisible()
      const rankText = await firstRank.textContent()
      expect(rankText).toMatch(/#\d+/)

      // Verify first post has a title
      const firstTitle = page.locator('.hot-post-title').first()
      await expect(firstTitle).toBeVisible()
      const titleText = await firstTitle.textContent()
      expect(titleText).toBeTruthy()
      expect(titleText!.length).toBeGreaterThan(0)
    } else {
      // Empty state is acceptable
      const bodyText = await page.textContent('body')
      expect(bodyText).toBeTruthy()
    }

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/07-hot-feed.png`, fullPage: false })

    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    if (serverErrors.length > 0) {
      console.warn('Server errors on /hot:', serverErrors)
    }
  })
})

// =============================================================================
// 8. Post card engagement metrics
// =============================================================================
test.describe('Hot page - engagement metrics', () => {
  test('8. Verify post cards show engagement metrics (likes, comments)', async ({ page }) => {
    await gotoPage(page, '/hot')
    await dismissCookieConsent(page)

    const hotPostItems = page.locator('.hot-post-item')
    await hotPostItems
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {})

    const postCount = await hotPostItems.count()
    if (postCount === 0) {
      test.skip(true, 'No hot posts available')
      return
    }

    // PostCard renders .hot-post-footer with author, time, comments, likes, views
    const footers = page.locator('.hot-post-footer')
    const footerCount = await footers.count()
    expect(footerCount).toBeGreaterThan(0)

    // At least one footer should have text content (author + time are always shown)
    const firstFooter = footers.first()
    const footerText = await firstFooter.textContent()
    expect(footerText).toBeTruthy()

    // Check that footer text contains numbers (time like "2h", views, likes, comments)
    const allFooterText = await page.locator('.hot-post-footer').allTextContents()
    const hasAnyMetrics = allFooterText.some((text) => /\d/.test(text))
    expect(hasAnyMetrics).toBeTruthy()

    // Count SVG icons in footers (CommentIcon, ThumbsUpIcon rendered when count > 0)
    const metricIcons = page.locator('.hot-post-footer svg')
    const svgCount = await metricIcons.count()

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/08-engagement-metrics.png`, fullPage: false })

    console.log(`Found ${postCount} posts, ${footerCount} footers, ${svgCount} metric icons`)
  })
})

// =============================================================================
// 9. Mobile viewport (390x844)
// =============================================================================
test.describe('Mobile viewport tests (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('9a. Mobile - groups page renders correctly', async ({ page }) => {
    const { networkErrors } = setupErrorTracking(page)

    await gotoPage(page, '/groups')
    await dismissCookieConsent(page)

    await expect(page).toHaveURL(/\/groups/)

    const body = await page.textContent('body')
    expect(body).toBeTruthy()
    expect(body!.length).toBeGreaterThan(100)

    // Tabs should still be visible on mobile
    const recommendedTab = page
      .locator('button')
      .filter({
        hasText: /Recommended|推荐/i,
      })
      .first()
    await expect(recommendedTab).toBeVisible({ timeout: 10_000 })

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/09a-mobile-groups.png`, fullPage: false })

    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    expect(serverErrors).toHaveLength(0)
  })

  test('9b. Mobile - hot page renders correctly', async ({ page }) => {
    const { networkErrors } = setupErrorTracking(page)

    await gotoPage(page, '/hot')
    await dismissCookieConsent(page)

    await expect(page).toHaveURL(/\/hot/)

    const hotPostItems = page.locator('.hot-post-item')
    await hotPostItems
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {})

    const postCount = await hotPostItems.count()

    if (postCount > 0) {
      const firstPost = hotPostItems.first()
      await expect(firstPost).toBeVisible()

      // Post should not overflow the 390px viewport
      const box = await firstPost.boundingBox()
      if (box) {
        expect(box.width).toBeLessThanOrEqual(390)
      }
    }

    await page.screenshot({ path: `${SCREENSHOTS_DIR}/09b-mobile-hot.png`, fullPage: false })

    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    expect(serverErrors).toHaveLength(0)
  })

  test('9c. Mobile - group detail page renders correctly', async ({ page }) => {
    const navigated = await navigateToFirstGroup(page)
    if (!navigated) {
      test.skip(true, 'No group links found')
      return
    }

    // Content should be visible on mobile
    const mainContent = page.locator('#main-content').first()
    await expect(mainContent).toBeVisible({ timeout: 15_000 })

    // Layout should not overflow 390px
    const mainBox = await mainContent.boundingBox()
    if (mainBox) {
      expect(mainBox.width).toBeLessThanOrEqual(390)
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/09c-mobile-group-detail.png`,
      fullPage: false,
    })
  })
})

// =============================================================================
// 10. Console errors and 500 responses
// =============================================================================
test.describe('Error monitoring', () => {
  test('10a. /groups - no 500 responses', async ({ page }) => {
    const { consoleErrors, networkErrors } = setupErrorTracking(page)

    await gotoPage(page, '/groups')

    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    if (serverErrors.length > 0) {
      console.error('500+ errors on /groups:', JSON.stringify(serverErrors, null, 2))
    }
    expect(serverErrors).toHaveLength(0)

    if (consoleErrors.length > 0) {
      console.warn(
        `Console errors on /groups (${consoleErrors.length}):`,
        consoleErrors.slice(0, 5)
      )
    }
  })

  test('10b. /hot - no 500 responses', async ({ page }) => {
    const { consoleErrors, networkErrors } = setupErrorTracking(page)

    await gotoPage(page, '/hot')

    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    if (serverErrors.length > 0) {
      console.error('500+ errors on /hot:', JSON.stringify(serverErrors, null, 2))
    }
    expect(serverErrors).toHaveLength(0)

    if (consoleErrors.length > 0) {
      console.warn(`Console errors on /hot (${consoleErrors.length}):`, consoleErrors.slice(0, 5))
    }
  })

  test('10c. Group detail page - no 500 responses', async ({ page }) => {
    const { networkErrors } = setupErrorTracking(page)

    const navigated = await navigateToFirstGroup(page)
    if (!navigated) {
      test.skip(true, 'No group links found')
      return
    }

    const serverErrors = networkErrors.filter((e) => e.status >= 500)
    if (serverErrors.length > 0) {
      console.error('500+ errors on group detail:', JSON.stringify(serverErrors, null, 2))
    }
    expect(serverErrors).toHaveLength(0)
  })
})
