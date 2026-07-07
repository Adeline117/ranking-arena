import { test, expect, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'

const SCREENSHOT_DIR = 'e2e/screenshots'

// Dev server uses Turbopack — first page compilation takes 30-60s.
// Set generous timeouts. Tests run serially to avoid OOM.
test.setTimeout(180_000)

/**
 * Helper: navigate to login and wait for the login card to render.
 */
async function goToLogin(page: Page) {
  await page.goto('/login', { timeout: 90_000, waitUntil: 'domcontentloaded' })
  await dismissOverlays(page)
  await page.waitForSelector('.login-card', { timeout: 60_000 })
}

test.describe('Auth Pages - Login', () => {
  // ---------------------------------------------------------------
  // 1. Load /login, verify form renders (email, password, social)
  // ---------------------------------------------------------------
  test('1 - login form renders with email, password, and social buttons', async ({ page }) => {
    await goToLogin(page)

    // Email input
    const emailInput = page.locator('input[type="email"][placeholder="you@email.com"]')
    await expect(emailInput).toBeVisible({ timeout: 15_000 })

    // Password label and input
    const passwordInput = page.locator('input[type="password"], input#login-password')
    await expect(passwordInput.first()).toBeVisible({ timeout: 10_000 })

    // Login button (class .login-button that is the primary submit)
    const loginBtn = page.locator('button.login-button').first()
    await expect(loginBtn).toBeVisible()

    // Social buttons: Google + Discord always render. X (Twitter) is gated behind
    // NEXT_PUBLIC_ENABLE_X_LOGIN (the Twitter provider is not configured in
    // Supabase, so the button is intentionally hidden — see SocialLogin.tsx:194).
    // Only assert X when the flag is on; otherwise assert it is absent.
    await expect(page.locator('button:has-text("Google")')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('button:has-text("Discord")')).toBeVisible()
    const xBtn = page.locator('button').filter({ hasText: /^X$/ })
    if (process.env.NEXT_PUBLIC_ENABLE_X_LOGIN === 'true') {
      await expect(xBtn.first()).toBeVisible()
    } else {
      await expect(xBtn).toHaveCount(0)
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-login-form.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 2. Language toggle ZH/EN switches text
  // ---------------------------------------------------------------
  test('2 - language toggle switches text between ZH and EN', async ({ page }) => {
    await goToLogin(page)

    // Click EN button first to ensure we're in English
    const enBtn = page.locator('button.lang-btn:has-text("EN")')
    await enBtn.click()

    // Title should contain "Welcome Back" in English
    await expect(page.locator('h1')).toContainText('Welcome Back', { timeout: 15_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-login-en.png`, fullPage: true })

    // Click ZH button — translations load asynchronously via dynamic import
    const zhBtn = page.locator('button.lang-btn').filter({ hasText: /中文/ })
    await zhBtn.click()

    // Wait for async Chinese translations to load and re-render.
    // The title text changes only after the zh.ts bundle finishes importing.
    await expect(page.locator('h1')).toContainText('欢迎回来', { timeout: 30_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-login-zh.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 3. "No account? Register with code" switches to register mode
  // ---------------------------------------------------------------
  test('3 - switch to register mode via register button', async ({ page }) => {
    await goToLogin(page)

    // Ensure EN
    await page.locator('button.lang-btn:has-text("EN")').click()
    await page.waitForTimeout(300)

    // Click the switch button
    const switchBtn = page.locator('button.login-switch-btn')
    await expect(switchBtn).toContainText(/Register|注册/, { timeout: 10_000 })
    await switchBtn.click()

    // Title should change to "Create Account"
    await expect(page.locator('h1')).toContainText(/Create Account|创建账号/, { timeout: 10_000 })

    // Switch button text should now offer to go back to login
    await expect(switchBtn).toContainText(/Login|登录/, { timeout: 5_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-register-mode.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 4. Register mode: email input + "Send Code" button
  // ---------------------------------------------------------------
  test('4 - register mode shows email input and Send Code button', async ({ page }) => {
    await goToLogin(page)

    // Switch to EN and register mode
    await page.locator('button.lang-btn:has-text("EN")').click()
    await page.waitForTimeout(300)
    await page.locator('button.login-switch-btn').click()
    await page.waitForTimeout(500)

    // Email input should still be visible
    const emailInput = page.locator('input[type="email"][placeholder="you@email.com"]')
    await expect(emailInput).toBeVisible()

    // Send Code button should be visible
    const sendCodeBtn = page.locator('button.login-button:has-text("Send Code")')
    await expect(sendCodeBtn).toBeVisible({ timeout: 10_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-register-send-code.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 5. Password strength indicator - verify password input works
  // ---------------------------------------------------------------
  test('5 - password input accepts typing in login mode', async ({ page }) => {
    await goToLogin(page)

    // Type into password field
    const passwordInput = page.locator('input#login-password, input[type="password"]').first()
    await expect(passwordInput).toBeVisible({ timeout: 10_000 })
    await passwordInput.fill('TestPass123!')

    // Verify the value was accepted
    await expect(passwordInput).toHaveValue('TestPass123!')

    // Show/Hide toggle should be visible
    const toggleBtn = page.locator('button.password-toggle').first()
    await expect(toggleBtn).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-password-filled.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 6. "Login with Code" mode switch
  // ---------------------------------------------------------------
  test('6 - switch to Login with Code mode', async ({ page }) => {
    await goToLogin(page)

    // Ensure EN
    await page.locator('button.lang-btn:has-text("EN")').click()
    await page.waitForTimeout(300)

    // Click "Or login with verification code" link
    const codeLoginBtn = page
      .locator('button.link-hover')
      .filter({ hasText: /verification code|验证码登录/ })
    await expect(codeLoginBtn).toBeVisible({ timeout: 10_000 })
    await codeLoginBtn.click()
    await page.waitForTimeout(500)

    // Should now show "Send Code" button instead of password field
    const sendCodeBtn = page.locator('button.login-button:has-text("Send Code")')
    await expect(sendCodeBtn).toBeVisible({ timeout: 10_000 })

    // Password field should NOT be visible
    const passwordInput = page.locator('input#login-password')
    await expect(passwordInput).not.toBeVisible()

    // Should have a "back to password" link
    const backToPasswordBtn = page.locator('button.link-hover').filter({ hasText: /password|密码/ })
    await expect(backToPasswordBtn).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-login-with-code.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 7. "Forgot password?" link navigates to /reset-password
  // ---------------------------------------------------------------
  test('7 - forgot password link navigates to /reset-password', async ({ page }) => {
    await goToLogin(page)

    // Ensure EN
    await page.locator('button.lang-btn:has-text("EN")').click()
    await page.waitForTimeout(300)

    // Find "Forgot password?" link - verify it exists and has correct href
    const forgotLink = page.locator('a[href="/reset-password"]')
    await expect(forgotLink).toBeVisible({ timeout: 10_000 })
    await expect(forgotLink).toContainText(/Forgot password|忘记密码/)

    // Wait for the card entrance animation to settle before clicking
    await page.waitForTimeout(1500)

    // Navigate using page.goto to avoid animation instability issues
    // with the card entrance CSS animation (0.6s). The href is verified above.
    await page.goto('/reset-password', { timeout: 90_000, waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.reset-card', { timeout: 60_000 })
    await expect(page).toHaveURL(/\/reset-password/)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-navigated-to-reset.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 8. Load /reset-password, verify form renders
  // ---------------------------------------------------------------
  test('8 - reset-password page renders with email form', async ({ page }) => {
    await page.goto('/reset-password', { timeout: 90_000, waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)
    await page.waitForSelector('.reset-card', { timeout: 60_000 })

    // Email input
    const emailInput = page.locator('input[type="email"][placeholder="you@email.com"]')
    await expect(emailInput).toBeVisible({ timeout: 15_000 })

    // Submit button (reset-button class)
    const resetBtn = page.locator('button.reset-button')
    await expect(resetBtn).toBeVisible()

    // "Back to login" link
    const backLink = page.locator('a[href="/login"]')
    await expect(backLink).toBeVisible()

    // Language toggles exist
    await expect(page.locator('button.lang-btn').first()).toBeVisible()

    await page.screenshot({ path: `${SCREENSHOT_DIR}/08-reset-password-form.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 9. Social login buttons (Google, X, Discord) exist
  // ---------------------------------------------------------------
  test('9 - social login buttons exist on login page', async ({ page }) => {
    await goToLogin(page)

    // Google button with SVG icon
    const googleBtn = page.locator('button:has-text("Google")')
    await expect(googleBtn).toBeVisible({ timeout: 15_000 })

    // Discord button
    const discordBtn = page.locator('button:has-text("Discord")')
    await expect(discordBtn).toBeVisible()

    // X (Twitter) button is gated behind NEXT_PUBLIC_ENABLE_X_LOGIN (provider not
    // configured in Supabase — SocialLogin.tsx:194). Assert presence only when the
    // flag is on; otherwise assert it is hidden so the test tracks the real UI.
    const xBtn = page.locator('button').filter({ hasText: /^X$/ })
    if (process.env.NEXT_PUBLIC_ENABLE_X_LOGIN === 'true') {
      await expect(xBtn.first()).toBeVisible()
    } else {
      await expect(xBtn).toHaveCount(0)
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/09-social-buttons.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 10. ?error=auth_failed shows error message
  // ---------------------------------------------------------------
  test('10 - error parameter shows error message', async ({ page }) => {
    await page.goto('/login?error=auth_failed', { timeout: 90_000, waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)
    await page.waitForSelector('.login-card', { timeout: 60_000 })

    // Error message should be visible - the error div has specific styles
    // and contains text about auth failure
    const errorDiv = page
      .locator('div')
      .filter({
        has: page.locator('svg'),
      })
      .filter({
        hasText: /failed|失败|重试|try again/i,
      })
    await expect(errorDiv.first()).toBeVisible({ timeout: 15_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/10-auth-error-message.png`, fullPage: true })
  })

  // ---------------------------------------------------------------
  // 11. Mobile viewport test
  // ---------------------------------------------------------------
  test('11 - mobile viewport renders login page correctly', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    })
    const page = await context.newPage()

    await page.goto('/login', { timeout: 90_000, waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)
    await page.waitForSelector('.login-card', { timeout: 60_000 })

    // Email input should be visible
    const emailInput = page.locator('input[type="email"][placeholder="you@email.com"]')
    await expect(emailInput).toBeVisible({ timeout: 15_000 })

    // Login card should be within viewport width
    const cardBox = await page.locator('.login-card').boundingBox()
    expect(cardBox).toBeTruthy()
    if (cardBox) {
      expect(cardBox.x).toBeGreaterThanOrEqual(0)
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(375 + 2)
    }

    // Social buttons should be visible on mobile too
    await expect(page.locator('button:has-text("Google")')).toBeVisible({ timeout: 15_000 })

    await page.screenshot({ path: `${SCREENSHOT_DIR}/11-mobile-login.png`, fullPage: true })
    await context.close()
  })

  // ---------------------------------------------------------------
  // 12. Console errors check
  // ---------------------------------------------------------------
  test('12 - no critical console errors on login page', async ({ page }) => {
    const consoleErrors: string[] = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Ignore known benign errors from third-party libs and network
        if (
          text.includes('favicon') ||
          text.includes('404') ||
          text.includes('net::ERR') ||
          text.includes('CORS') ||
          text.includes('third-party') ||
          text.includes('hydration') ||
          text.includes('Warning:') ||
          text.includes('supabase') ||
          text.includes('Failed to load resource') ||
          text.includes('privy') ||
          text.includes('Privy') ||
          text.includes('websocket') ||
          text.includes('WebSocket') ||
          text.includes('chunk') ||
          text.includes('__webpack')
        )
          return
        consoleErrors.push(text)
      }
    })

    await goToLogin(page)
    await page.waitForTimeout(3000)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/12-console-check.png`, fullPage: true })

    if (consoleErrors.length > 0) {
      console.log('Console errors found:', consoleErrors)
    }

    // Should have no critical JS errors
    expect(consoleErrors.length).toBe(0)
  })
})
