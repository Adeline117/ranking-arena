import { expect, test, type Page } from '@playwright/test'

const USER_ID = '22222222-2222-4222-8222-222222222222'
const LONG_KEY_NAME = 'n'.repeat(50)
// Deliberately exceeds the production mask length to keep the row defensive
// against malformed/legacy payloads. Existing rows must never expose Copy.
const DEFENSIVE_LONG_KEY_CODE = `ra_live_${'k'.repeat(160)}`
const FULL_CREATED_KEY = `ra_live_${'s'.repeat(80)}`

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function fakeSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
  return {
    access_token: `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({ sub: USER_ID, exp: expiresAt, role: 'authenticated' })}.signature`,
    refresh_token: 'api-tier-mobile-refresh-token',
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'api-tier-mobile@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: '2026-01-01T00:00:00.000Z',
    },
  }
}

async function installSettingsFixture(page: Page, language: 'en' | 'ja') {
  await page.addInitScript(
    ({ locale, session }) => {
      Object.defineProperty(window, 'requestIdleCallback', {
        configurable: true,
        value: () => 0,
      })
      localStorage.setItem('arena-auth', JSON.stringify(session))
      localStorage.setItem('language', locale)
      localStorage.setItem('cookie_consent', 'accepted')
    },
    { locale: language, session: fakeSession() }
  )

  await page.route('**/rest/v1/user_profiles*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 400, body: '{}' })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-range': '0-0/*' },
      body: JSON.stringify({
        id: USER_ID,
        handle: 'api_tier_mobile',
        bio: '',
        avatar_url: null,
        cover_url: null,
        show_followers: true,
        show_following: true,
        dm_permission: 'all',
        show_pro_badge: true,
        is_pro: false,
      }),
    })
  })

  await page.route('**/rest/v1/rpc/get_own_profile_sensitive*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        notify_follow: true,
        notify_like: true,
        notify_comment: true,
        notify_mention: true,
        notify_message: true,
        notify_trader_events: true,
        totp_enabled: false,
        email_digest: 'none',
      }),
    })
  })

  // Register the catch-all first: Playwright evaluates routes in reverse
  // registration order, so the settings-specific contracts below take precedence.
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    })
  })
  await page.route('**/api/exchange/connections', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { connections: [] } }),
    })
  })
  await page.route('**/api/traders/linked', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { linked_traders: [] } }),
    })
  })
  await page.route('**/api/user/api-keys', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ data: { key: FULL_CREATED_KEY } }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 'long-key-mobile',
            name: LONG_KEY_NAME,
            key: DEFENSIVE_LONG_KEY_CODE,
            tier: 'free',
            daily_limit: 100,
            request_count_today: 7,
            active: true,
            last_used_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            revoked_at: null,
          },
        ],
      }),
    })
  })
  await page.route('**/api/user/api-keys/usage*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { daily: [], keys: [], totals: {} },
      }),
    })
  })
}

test('API plan and long API key row reflow without page overflow at 320px', async ({
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one explicit Chromium viewport is sufficient')

  for (const scenario of [
    {
      language: 'en' as const,
      planLabel: 'API Plan:',
      starter: 'Upgrade to Starter',
      pro: 'Upgrade to Pro',
      copy: 'Copy',
      revoke: 'Revoke',
      create: 'Create Key',
      dismiss: 'Dismiss',
    },
    {
      language: 'ja' as const,
      planLabel: 'API プラン：',
      starter: 'Starter にアップグレード',
      pro: 'Proにアップグレード',
      copy: 'コピー',
      revoke: '取り消し',
      create: 'キーを作成',
      dismiss: '閉じる',
    },
  ]) {
    for (const height of [568, 720]) {
      const context = await browser.newContext({
        viewport: { width: 320, height },
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
      })
      const page = await context.newPage()
      await installSettingsFixture(page, scenario.language)

      await page.goto('/settings', { waitUntil: 'domcontentloaded' })
      const planLabel = page.getByText(scenario.planLabel, { exact: true })
      await expect(planLabel).toBeVisible({ timeout: 60_000 })

      const banner = page.locator('.api-tier-banner')
      const summary = page.locator('.api-tier-banner-summary')
      const actions = page.locator('.api-tier-banner-actions')
      const starter = page.getByRole('button', { name: scenario.starter, exact: true })
      const pro = page.getByRole('button', { name: scenario.pro, exact: true })
      const keyRow = page.locator('.api-key-row').first()
      const keyName = keyRow.locator('.api-key-row-name')
      const keyCode = keyRow.locator('.api-key-row-code')
      const keyActions = keyRow.locator('.api-key-row-actions')
      const copy = keyRow.getByRole('button', { name: scenario.copy, exact: true })
      const revoke = keyRow.getByRole('button', { name: scenario.revoke, exact: true })
      const create = page.getByRole('button', { name: scenario.create, exact: true })

      await banner.scrollIntoViewIfNeeded()
      await expect(starter).toBeEnabled()
      await expect(pro).toBeEnabled()

      const [bannerBox, summaryBox, actionsBox, starterBox, proBox] = await Promise.all([
        banner.boundingBox(),
        summary.boundingBox(),
        actions.boundingBox(),
        starter.boundingBox(),
        pro.boundingBox(),
      ])

      for (const box of [bannerBox, summaryBox, actionsBox, starterBox, proBox]) {
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(320)
      }
      expect(summaryBox!.y + summaryBox!.height).toBeLessThanOrEqual(actionsBox!.y)
      expect(starterBox!.height).toBeGreaterThanOrEqual(44)
      expect(proBox!.height).toBeGreaterThanOrEqual(44)

      await keyRow.scrollIntoViewIfNeeded()
      await expect(keyName).toHaveText(LONG_KEY_NAME)
      await expect(keyCode).toHaveText(DEFENSIVE_LONG_KEY_CODE)
      await expect(copy).toHaveCount(0)
      await expect(revoke).toBeEnabled()

      const [rowBox, keyActionsBox, revokeBox, widths] = await Promise.all([
        keyRow.boundingBox(),
        keyActions.boundingBox(),
        revoke.boundingBox(),
        page.evaluate(() => {
          const selectors = [
            '#api-keys',
            '.api-key-row',
            '.api-key-row-main',
            '.api-key-row-identity',
            '.api-key-row-name',
            '.api-key-row-code',
            '.api-key-row-actions',
          ]
          return {
            page: {
              bodyClient: document.body.clientWidth,
              bodyScroll: document.body.scrollWidth,
              htmlClient: document.documentElement.clientWidth,
              htmlScroll: document.documentElement.scrollWidth,
            },
            local: selectors.map((selector) => {
              const element = document.querySelector<HTMLElement>(selector)
              return {
                selector,
                clientWidth: element?.clientWidth ?? -1,
                scrollWidth: element?.scrollWidth ?? -1,
              }
            }),
          }
        }),
      ])

      for (const box of [rowBox, keyActionsBox, revokeBox]) {
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(320)
      }
      expect(revokeBox!.height).toBeGreaterThanOrEqual(44)
      expect(revokeBox!.width).toBeGreaterThanOrEqual(44)
      expect(widths.page.bodyScroll).toBeLessThanOrEqual(widths.page.bodyClient)
      expect(widths.page.htmlScroll).toBeLessThanOrEqual(widths.page.htmlClient)
      for (const local of widths.local) {
        expect(local.clientWidth, `${local.selector} should exist`).toBeGreaterThanOrEqual(0)
        expect(local.scrollWidth, `${local.selector} should not overflow`).toBeLessThanOrEqual(
          local.clientWidth
        )
      }

      await expect(create).toBeEnabled()
      const createBox = await create.boundingBox()
      expect(createBox).not.toBeNull()
      expect(createBox!.height).toBeGreaterThanOrEqual(44)
      expect(createBox!.width).toBeGreaterThanOrEqual(44)

      const keyNameInput = page.locator('.api-key-create-row input')
      await keyNameInput.fill('mobile-created-key')
      await create.click()

      const createdCode = page.locator('.api-created-key-code')
      const createdCopy = page.locator('.api-created-key-copy')
      const createdDismiss = page.locator('.api-created-key-dismiss')
      await expect(createdCopy).toHaveAccessibleName(scenario.copy)
      await expect(createdDismiss).toHaveAccessibleName(scenario.dismiss)
      await expect(createdCode).toHaveText(FULL_CREATED_KEY)
      await expect(createdCopy).toBeVisible()
      await expect(createdDismiss).toBeVisible()

      const [createdCodeBox, createdCopyBox, createdDismissBox, createdWidths] = await Promise.all([
        createdCode.boundingBox(),
        createdCopy.boundingBox(),
        createdDismiss.boundingBox(),
        page.evaluate(() => {
          const secret = document.querySelector<HTMLElement>('.api-created-key-secret')
          const code = document.querySelector<HTMLElement>('.api-created-key-code')
          return {
            bodyClient: document.body.clientWidth,
            bodyScroll: document.body.scrollWidth,
            secretClient: secret?.clientWidth ?? -1,
            secretScroll: secret?.scrollWidth ?? -1,
            codeClient: code?.clientWidth ?? -1,
            codeScroll: code?.scrollWidth ?? -1,
          }
        }),
      ])
      for (const box of [createdCodeBox, createdCopyBox, createdDismissBox]) {
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(320)
      }
      expect(createdCopyBox!.height).toBeGreaterThanOrEqual(44)
      expect(createdDismissBox!.height).toBeGreaterThanOrEqual(44)
      expect(createdDismissBox!.width).toBeGreaterThanOrEqual(44)
      expect(createdWidths.bodyScroll).toBeLessThanOrEqual(createdWidths.bodyClient)
      expect(createdWidths.secretScroll).toBeLessThanOrEqual(createdWidths.secretClient)
      expect(createdWidths.codeScroll).toBeLessThanOrEqual(createdWidths.codeClient)

      for (const button of [starter, pro, revoke, create, createdCopy, createdDismiss]) {
        await button.evaluate((element) =>
          element.scrollIntoView({ block: 'center', behavior: 'instant' })
        )
        await button.focus()
        await expect(button).toBeFocused()
        await page.keyboard.press('Shift+Tab')
        await expect(button).not.toBeFocused()
        await page.keyboard.press('Tab')
        await expect(button).toBeFocused()
        const centerHit = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
          )
          return {
            matches: hit?.closest('button') === element,
            rect: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            },
            hit: hit?.getAttribute('aria-label') || hit?.tagName || null,
          }
        })
        expect(
          centerHit.matches,
          `${await button.getAttribute('aria-label')} should receive center hit: ${JSON.stringify(centerHit)}`
        ).toBe(true)
      }

      await page.screenshot({
        path: testInfo.outputPath(
          `settings-api-tier-key-row-320x${height}-${scenario.language}.png`
        ),
        fullPage: true,
      })
      await context.close()
    }
  }
})
