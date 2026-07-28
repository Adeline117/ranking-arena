import { expect, test, type Locator, type Page } from '@playwright/test'

const USER_ID = '11111111-1111-4111-8111-111111111111'

type Rect = { x: number; y: number; width: number; height: number }

type CookieMutationSnapshot = {
  offset: number
  height: number
}

function intersectionArea(first: Rect, second: Rect): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
  )
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
  )
  return width * height
}

function expectInsideViewport(rect: Rect, width: number, height: number): void {
  expect(rect.x).toBeGreaterThanOrEqual(0)
  expect(rect.y).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(width)
  expect(rect.y + rect.height).toBeLessThanOrEqual(height)
}

async function expectCenterHittable(locator: Locator): Promise<void> {
  expect(
    await locator.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return target === element || element.contains(target)
    })
  ).toBe(true)
}

async function captureCookieMutationBeforeFirstRaf(page: Page): Promise<{
  mutationMicrotask: CookieMutationSnapshot
  firstRaf: CookieMutationSnapshot
  restoredRaf: CookieMutationSnapshot
}> {
  return page.evaluate(async () => {
    const banner = document.querySelector<HTMLElement>('.cookie-consent')
    const description = document.querySelector<HTMLElement>('.cookie-consent-description')
    const textNode = description
      ? Array.from(description.childNodes).find((node) => node.nodeType === Node.TEXT_NODE)
      : null
    if (!banner || !(textNode instanceof Text)) {
      throw new Error('Cookie consent copy is unavailable for the mutation audit')
    }

    const originalText = textNode.data
    const capture = (): CookieMutationSnapshot => ({
      offset: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--transient-bottom-offset')
      ),
      height: Math.ceil(banner.getBoundingClientRect().height),
    })

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        textNode.data = originalText
        reject(new Error('Cookie mutation was not observed before the first animation frame'))
      }, 2_000)
      const observer = new MutationObserver(() => {
        observer.disconnect()
        const mutationMicrotask = capture()
        requestAnimationFrame(() => {
          const firstRaf = capture()
          textNode.data = originalText
          requestAnimationFrame(() => {
            window.clearTimeout(timeout)
            resolve({
              mutationMicrotask,
              firstRaf,
              restoredRaf: capture(),
            })
          })
        })
      })
      observer.observe(banner, {
        characterData: true,
        childList: true,
        subtree: true,
      })

      textNode.data = `${originalText} ${'translated layout copy '.repeat(8)}`
    })
  })
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function fakeSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
  return {
    access_token: `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({ sub: USER_ID, exp: expiresAt, role: 'authenticated' })}.signature`,
    refresh_token: 'fixture-refresh-token',
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'mobile-layout@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: '2026-01-01T00:00:00.000Z',
    },
  }
}

async function installSettingsFixture(
  page: Page,
  language: 'en' | 'ja',
  cookieConsent: 'accepted' | 'unset',
  comparisonCount: number,
  safeAreaBottom = 0
) {
  const sources = ['binance', 'bybit', 'okx'] as const
  const selectedTraders = Array.from({ length: comparisonCount }, (_, index) => ({
    id: `fixture-${index}`,
    source: sources[index % sources.length],
    handle: `long_fixture_handle_${index}`,
  }))

  await page.addInitScript(
    ({ session, locale, comparison, consent, safeBottom }) => {
      // Background preloading all language dictionaries is unrelated to layout
      // and would repeatedly recreate `t` while this focused fixture initializes.
      Object.defineProperty(window, 'requestIdleCallback', {
        configurable: true,
        value: () => 0,
      })
      localStorage.setItem('arena-auth', JSON.stringify(session))
      localStorage.setItem('language', locale)
      if (consent === 'accepted') {
        localStorage.setItem('cookie_consent', 'accepted')
      } else {
        localStorage.removeItem('cookie_consent')
      }
      localStorage.setItem('ranking-arena-comparison', JSON.stringify(comparison))
      const applySafeArea = () =>
        document.documentElement?.style.setProperty('--safe-area-inset-bottom', `${safeBottom}px`)
      applySafeArea()
      if (!document.documentElement) {
        const rootObserver = new MutationObserver(() => {
          if (!document.documentElement) return
          applySafeArea()
          rootObserver.disconnect()
        })
        rootObserver.observe(document, { childList: true })
      }
    },
    {
      session: fakeSession(),
      locale: language,
      consent: cookieConsent,
      safeBottom: safeAreaBottom,
      comparison: {
        state: {
          selectedTraders,
          isBarExpanded: true,
        },
        version: 2,
      },
    }
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
        handle: 'mobile_layout_fixture',
        bio: 'Existing profile bio',
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

  // Keep unrelated lazy settings cards deterministic. Their contracts are
  // covered by focused tests; this spec only needs the profile/save-bar flow.
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const body =
      pathname === '/api/traders/linked'
        ? { data: { linked_traders: [] } }
        : pathname === '/api/exchange/connections'
          ? { data: { connections: [] } }
          : pathname === '/api/groups'
            ? { data: [], groups: [], posts: [] }
            : { data: [] }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

test('settings save controls stay usable across narrow and short mobile layouts', async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'one explicit Chromium viewport matrix is sufficient'
  )

  const cases = [
    {
      width: 320,
      language: 'en' as const,
      height: 720,
      safeAreaBottom: 0,
      cookieConsent: 'accepted' as const,
      comparisonCount: 3,
      discard: 'Discard',
      save: 'Save All Changes',
      scrollToTop: 'Back to top',
    },
    {
      width: 320,
      language: 'ja' as const,
      height: 720,
      safeAreaBottom: 0,
      cookieConsent: 'accepted' as const,
      comparisonCount: 3,
      discard: '破棄',
      save: 'すべての変更を保存',
      scrollToTop: 'トップに戻る',
    },
    {
      width: 375,
      language: 'en' as const,
      height: 720,
      safeAreaBottom: 0,
      cookieConsent: 'accepted' as const,
      comparisonCount: 3,
      discard: 'Discard',
      save: 'Save All Changes',
      scrollToTop: 'Back to top',
    },
    {
      width: 320,
      height: 568,
      safeAreaBottom: 0,
      language: 'en' as const,
      cookieConsent: 'accepted' as const,
      comparisonCount: 3,
      discard: 'Discard',
      save: 'Save All Changes',
      scrollToTop: 'Back to top',
    },
    {
      width: 320,
      height: 568,
      safeAreaBottom: 0,
      language: 'en' as const,
      cookieConsent: 'accepted' as const,
      comparisonCount: 10,
      discard: 'Discard',
      save: 'Save All Changes',
      scrollToTop: 'Back to top',
    },
    {
      width: 320,
      height: 568,
      safeAreaBottom: 0,
      language: 'en' as const,
      cookieConsent: 'unset' as const,
      comparisonCount: 10,
      discard: 'Discard',
      save: 'Save All Changes',
      scrollToTop: 'Back to top',
    },
    {
      width: 320,
      height: 568,
      safeAreaBottom: 34,
      language: 'en' as const,
      cookieConsent: 'accepted' as const,
      comparisonCount: 3,
      discard: 'Discard',
      save: 'Save All Changes',
      scrollToTop: 'Back to top',
    },
  ]

  for (const scenario of cases) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    })
    const page = await context.newPage()
    await installSettingsFixture(
      page,
      scenario.language,
      scenario.cookieConsent,
      scenario.comparisonCount,
      scenario.safeAreaBottom
    )

    await page.goto('/settings', { waitUntil: 'domcontentloaded' })
    const bio = page.locator('textarea').first()
    await expect(bio).toBeVisible({ timeout: 60_000 })
    // Let the selected language dictionary finish hydrating before editing
    // viewer-owned profile state.
    await page.waitForTimeout(2_000)
    await expect(bio).toBeVisible()
    await bio.fill('Existing profile bio with an unsaved mobile-only change')

    const saveBar = page.locator('.settings-save-bar')
    await expect(saveBar).toBeVisible()
    const discardButton = saveBar.locator('.settings-save-bar-button').nth(0)
    const saveButton = saveBar.locator('.settings-save-bar-button').nth(1)
    await expect(discardButton).toHaveAccessibleName(scenario.discard)
    await expect(saveButton).toHaveAccessibleName(scenario.save)
    const cookieConsent = page.locator('.cookie-consent')
    if (scenario.cookieConsent === 'unset') {
      await expect(cookieConsent).toBeVisible()
    } else {
      await expect(cookieConsent).toHaveCount(0)
    }
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              '--page-bottom-overlay-offset'
            )
          )
        )
      )
      .toBeGreaterThan(0)

    const mobileNav = page.locator('.mobile-bottom-nav')
    const compareBar = page.locator('.compare-floating-bar')
    const compareToggle = compareBar.locator('.compare-floating-toggle')
    const compareTraderList = compareBar.locator('.compare-trader-list')
    const compareClear = compareBar.locator('.compare-clear-button')
    const compareView = compareBar.locator('.compare-view-link')
    const feedbackButton = page.getByRole('button', { name: 'Feedback', exact: true })
    await expect(compareBar).toBeVisible({ timeout: 60_000 })
    await expect(compareBar).toContainText(`${scenario.comparisonCount}/10`)
    await expect(compareToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(compareClear).toBeVisible()
    await expect(compareView).toBeVisible()
    await expect(feedbackButton).toBeVisible({ timeout: 60_000 })

    const cookieBox = scenario.cookieConsent === 'unset' ? await cookieConsent.boundingBox() : null
    const [
      barBox,
      navBox,
      discardBox,
      saveBox,
      compareBox,
      compareToggleBox,
      compareClearBox,
      compareViewBox,
      feedbackBox,
      barWidths,
      discardWidths,
      saveWidths,
    ] = await Promise.all([
      saveBar.boundingBox(),
      mobileNav.boundingBox(),
      discardButton.boundingBox(),
      saveButton.boundingBox(),
      compareBar.boundingBox(),
      compareToggle.boundingBox(),
      compareClear.boundingBox(),
      compareView.boundingBox(),
      feedbackButton.boundingBox(),
      saveBar.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      })),
      discardButton.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      })),
      saveButton.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      })),
    ])

    expect(barBox).not.toBeNull()
    expect(navBox).not.toBeNull()
    expect(discardBox).not.toBeNull()
    expect(saveBox).not.toBeNull()
    expect(compareBox).not.toBeNull()
    expect(compareToggleBox).not.toBeNull()
    expect(compareClearBox).not.toBeNull()
    expect(compareViewBox).not.toBeNull()
    expect(feedbackBox).not.toBeNull()
    expect(navBox!.height).toBeCloseTo(60 + scenario.safeAreaBottom, 0)
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom')
          )
        )
      )
      .toBe(scenario.safeAreaBottom)

    expectInsideViewport(compareBox!, scenario.width, scenario.height)
    expectInsideViewport(compareToggleBox!, scenario.width, scenario.height)
    expectInsideViewport(compareClearBox!, scenario.width, scenario.height)
    expectInsideViewport(compareViewBox!, scenario.width, scenario.height)
    const compareHitTargets = await page.evaluate(
      ({ toggle, clear, view }) => {
        const ownsCenter = (box: Rect, selector: string) =>
          document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest(selector)
            ?.classList.contains(selector.slice(1)) ?? false
        return {
          toggle: ownsCenter(toggle, '.compare-floating-toggle'),
          clear: ownsCenter(clear, '.compare-clear-button'),
          view: ownsCenter(view, '.compare-view-link'),
        }
      },
      { toggle: compareToggleBox!, clear: compareClearBox!, view: compareViewBox! }
    )
    expect(compareHitTargets).toEqual({ toggle: true, clear: true, view: true })
    if (scenario.comparisonCount === 10) {
      const listOverflow = await compareTraderList.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }))
      expect(listOverflow.scrollHeight).toBeGreaterThan(listOverflow.clientHeight)
    }
    for (const box of [barBox!, discardBox!, saveBox!]) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(scenario.width)
    }
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(navBox!.y)
    expect(discardBox!.x + discardBox!.width).toBeLessThanOrEqual(saveBox!.x)
    expect(barWidths.scroll).toBeLessThanOrEqual(barWidths.client)
    expect(discardWidths.scroll).toBeLessThanOrEqual(discardWidths.client)
    expect(saveWidths.scroll).toBeLessThanOrEqual(saveWidths.client)
    expect(discardBox!.width).toBeGreaterThanOrEqual(24)
    expect(discardBox!.height).toBeGreaterThanOrEqual(44)
    expect(saveBox!.width).toBeGreaterThanOrEqual(24)
    expect(saveBox!.height).toBeGreaterThanOrEqual(44)
    expect(intersectionArea(barBox!, compareBox!)).toBe(0)
    expect(intersectionArea(barBox!, feedbackBox!)).toBe(0)
    expect(intersectionArea(compareBox!, feedbackBox!)).toBe(0)
    if (cookieBox) {
      expectInsideViewport(cookieBox, scenario.width, scenario.height)
      expect(intersectionArea(barBox!, cookieBox)).toBe(0)
      expect(intersectionArea(compareBox!, cookieBox)).toBe(0)
      expect(intersectionArea(feedbackBox!, cookieBox)).toBe(0)
    }

    await discardButton.focus()
    const focusStyle = await discardButton.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        focusVisible: element.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      }
    })
    expect(focusStyle.focusVisible).toBe(true)
    expect(focusStyle.outlineStyle).not.toBe('none')
    expect(focusStyle.outlineWidth).toBeGreaterThan(0)
    const focusedBox = await discardButton.boundingBox()
    expect(focusedBox).not.toBeNull()
    expect(focusedBox!.y + focusedBox!.height + focusStyle.outlineWidth).toBeLessThanOrEqual(
      navBox!.y
    )

    await page.evaluate(() => window.scrollTo(0, 700))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
    const scrollToTopButton = page.getByRole('button', {
      name: scenario.scrollToTop,
      exact: true,
    })
    await expect(scrollToTopButton).toBeVisible()
    await page.waitForTimeout(350)

    const [
      scrolledBarBox,
      scrolledSaveBox,
      scrolledCompareBox,
      scrolledFeedbackBox,
      scrollToTopBox,
    ] = await Promise.all([
      saveBar.boundingBox(),
      saveButton.boundingBox(),
      compareBar.boundingBox(),
      feedbackButton.boundingBox(),
      scrollToTopButton.boundingBox(),
    ])
    expect(scrolledBarBox).not.toBeNull()
    expect(scrolledSaveBox).not.toBeNull()
    expect(scrolledCompareBox).not.toBeNull()
    expect(scrolledFeedbackBox).not.toBeNull()
    expect(scrollToTopBox).not.toBeNull()
    expectInsideViewport(scrolledCompareBox!, scenario.width, scenario.height)

    const globalBottomBoxes = [
      scrolledBarBox!,
      scrolledCompareBox!,
      scrolledFeedbackBox!,
      scrollToTopBox!,
      ...(cookieBox ? [cookieBox] : []),
    ]
    for (let first = 0; first < globalBottomBoxes.length; first += 1) {
      for (let second = first + 1; second < globalBottomBoxes.length; second += 1) {
        expect(intersectionArea(globalBottomBoxes[first], globalBottomBoxes[second])).toBe(0)
      }
    }
    expect(intersectionArea(scrolledSaveBox!, scrolledCompareBox!)).toBe(0)
    expect(intersectionArea(scrolledSaveBox!, scrolledFeedbackBox!)).toBe(0)
    expect(intersectionArea(scrolledSaveBox!, scrollToTopBox!)).toBe(0)

    const saveHitTargets = await page.evaluate(
      ({ box }) =>
        [0.2, 0.5, 0.8].flatMap((xRatio) =>
          [0.25, 0.5, 0.75].map((yRatio) => {
            const target = document.elementFromPoint(
              box.x + box.width * xRatio,
              box.y + box.height * yRatio
            )
            return target?.closest('button')?.getAttribute('aria-label') ?? null
          })
        ),
      { box: scrolledSaveBox! }
    )
    expect(saveHitTargets).toEqual(Array(9).fill(scenario.save))

    if (scenario.height === 568 && scenario.comparisonCount === 10) {
      await testInfo.attach(`settings-320x568-10-${scenario.cookieConsent}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
    }

    await compareToggle.focus()
    await page.keyboard.press('Enter')
    await expect(compareToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(compareClear).toHaveCount(0)
    expect(await compareToggle.evaluate((element) => document.activeElement === element)).toBe(true)
    await page.keyboard.press('Space')
    await expect(compareToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(compareClear).toBeVisible()
    await expect(compareView).toBeVisible()
    expect(await compareToggle.evaluate((element) => document.activeElement === element)).toBe(true)

    if (scenario.height === 568) {
      await feedbackButton.click()
      const feedbackPanel = page.locator('.feedback-panel')
      const feedbackClose = feedbackPanel.locator('.feedback-panel-close')
      const feedbackMessage = feedbackPanel.locator('textarea')
      const feedbackSubmit = feedbackPanel.locator('.feedback-panel-submit')
      await expect(feedbackPanel).toBeVisible()
      await expect(page.locator('html')).toHaveClass(/has-feedback-panel/)
      await expect(feedbackButton).toBeHidden()
      await expect(compareBar).toBeHidden()
      await expect(scrollToTopButton).toBeHidden()
      expect(await feedbackClose.evaluate((element) => document.activeElement === element)).toBe(
        true
      )

      const [panelBox, currentSaveBox, currentCookieBox] = await Promise.all([
        feedbackPanel.boundingBox(),
        saveBar.boundingBox(),
        scenario.cookieConsent === 'unset' ? cookieConsent.boundingBox() : Promise.resolve(null),
      ])
      expect(panelBox).not.toBeNull()
      expect(currentSaveBox).not.toBeNull()
      expectInsideViewport(panelBox!, scenario.width, scenario.height)
      expect(intersectionArea(panelBox!, currentSaveBox!)).toBe(0)
      if (currentCookieBox) {
        expectInsideViewport(currentCookieBox, scenario.width, scenario.height)
        expect(intersectionArea(panelBox!, currentCookieBox)).toBe(0)
      }

      await feedbackMessage.fill('Short-screen feedback layout verification')
      await expect(feedbackSubmit).toBeEnabled()
      await expectCenterHittable(feedbackClose)
      await expectCenterHittable(feedbackMessage)
      await expectCenterHittable(feedbackSubmit)
      await expectCenterHittable(saveButton)
      if (scenario.cookieConsent === 'unset') {
        await expectCenterHittable(cookieConsent.locator('.cookie-consent-action-primary'))
      }
      await feedbackClose.click()
      await expect(feedbackPanel).toHaveCount(0)
      await expect(page.locator('html')).not.toHaveClass(/has-feedback-panel/)
      await expect(feedbackButton).toBeVisible()
      await expect(compareBar).toBeVisible()
      await expect(scrollToTopButton).toBeVisible()
      expect(await feedbackButton.evaluate((element) => document.activeElement === element)).toBe(
        true
      )
    }

    await context.close()
  }
})

test('exact 320x568 bottom stack keeps cookie mutation and feedback body usable', async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'one exact Chromium viewport is sufficient for the bottom-stack contract'
  )

  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  await installSettingsFixture(page, 'en', 'unset', 10, 34)
  await page.goto('/settings', { waitUntil: 'domcontentloaded' })

  const bio = page.locator('textarea').first()
  await expect(bio).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(2_000)
  await bio.fill('Exact bottom-stack dirty settings state')

  const saveBar = page.locator('.settings-save-bar')
  const saveButtons = saveBar.locator('.settings-save-bar-button')
  const saveButton = saveButtons.nth(1)
  const cookieConsent = page.locator('.cookie-consent')
  const compareBar = page.locator('.compare-floating-bar')
  const compareToggle = compareBar.locator('.compare-floating-toggle')
  const feedbackButton = page.getByRole('button', { name: 'Feedback', exact: true })
  await expect(saveBar).toBeVisible()
  await expect(cookieConsent).toBeVisible()
  await expect(compareBar).toBeVisible()
  await expect(compareBar).toContainText('10/10')
  await expect(compareToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(feedbackButton).toBeVisible()

  // Confirm the ten-item state, then use the real control to make Feedback the
  // only expanded transient surface on a viewport that cannot fit both panels.
  await compareToggle.click()
  await expect(compareToggle).toHaveAttribute('aria-expanded', 'false')
  expect(await compareToggle.evaluate((element) => document.activeElement === element)).toBe(true)

  // The browser-side promise observes a real post-mount characterData mutation
  // and snapshots its microtask plus the immediately following frame. No
  // test-side polling can wait past a stale first frame.
  const cookieMutation = await captureCookieMutationBeforeFirstRaf(page)
  for (const snapshot of [
    cookieMutation.mutationMicrotask,
    cookieMutation.firstRaf,
    cookieMutation.restoredRaf,
  ]) {
    expect(snapshot.height).toBeGreaterThan(0)
    expect(snapshot.offset).toBe(snapshot.height)
  }
  expect(cookieMutation.mutationMicrotask.height).toBeGreaterThan(cookieMutation.restoredRaf.height)
  expect(cookieMutation.firstRaf).toEqual(cookieMutation.mutationMicrotask)

  const [discardBox, saveBox] = await Promise.all([
    saveButtons.nth(0).boundingBox(),
    saveButton.boundingBox(),
  ])
  expect(discardBox).not.toBeNull()
  expect(saveBox).not.toBeNull()
  expect(discardBox!.height).toBeGreaterThanOrEqual(44)
  expect(saveBox!.height).toBeGreaterThanOrEqual(44)

  await feedbackButton.click()
  const feedbackPanel = page.locator('.feedback-panel')
  const feedbackHeader = feedbackPanel.locator('.feedback-panel-header')
  const feedbackBody = feedbackPanel.locator('.feedback-panel-body')
  const feedbackFooter = feedbackPanel.locator('.feedback-panel-footer')
  const feedbackClose = feedbackPanel.locator('.feedback-panel-close')
  const feedbackMessage = feedbackPanel.locator('textarea')
  const feedbackSubmit = feedbackPanel.locator('.feedback-panel-submit')
  await expect(feedbackPanel).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/has-feedback-panel/)
  await expect(compareBar).toBeHidden()
  await expect(feedbackButton).toBeHidden()
  expect(await feedbackClose.evaluate((element) => document.activeElement === element)).toBe(true)

  const [
    panelBox,
    headerBox,
    bodyBox,
    footerBox,
    messageBox,
    currentSaveBox,
    currentCookieBox,
    bodyOverflow,
  ] = await Promise.all([
    feedbackPanel.boundingBox(),
    feedbackHeader.boundingBox(),
    feedbackBody.boundingBox(),
    feedbackFooter.boundingBox(),
    feedbackMessage.boundingBox(),
    saveBar.boundingBox(),
    cookieConsent.boundingBox(),
    feedbackBody.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    })),
  ])
  for (const box of [
    panelBox,
    headerBox,
    bodyBox,
    footerBox,
    messageBox,
    currentSaveBox,
    currentCookieBox,
  ]) {
    expect(box).not.toBeNull()
  }
  for (const box of [panelBox!, headerBox!, bodyBox!, footerBox!]) {
    expectInsideViewport(box, 320, 568)
  }
  expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(bodyBox!.y)
  expect(bodyBox!.y + bodyBox!.height).toBeLessThanOrEqual(footerBox!.y)
  expect(headerBox!.y).toBeGreaterThanOrEqual(panelBox!.y)
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height)
  expect(intersectionArea(panelBox!, currentSaveBox!)).toBe(0)
  expect(intersectionArea(panelBox!, currentCookieBox!)).toBe(0)
  expect(bodyOverflow.overflowY).toBe('auto')
  expect(bodyOverflow.clientHeight).toBeGreaterThanOrEqual(24)
  expect(bodyOverflow.scrollHeight).toBeGreaterThan(bodyOverflow.clientHeight)
  expect(intersectionArea(bodyBox!, messageBox!)).toBeGreaterThanOrEqual(messageBox!.width * 16)

  await feedbackMessage.fill('Exact short-screen feedback verification')
  await expect(feedbackSubmit).toBeEnabled()
  await expectCenterHittable(feedbackClose)
  await expectCenterHittable(feedbackSubmit)
  await expectCenterHittable(saveButton)
  await expectCenterHittable(cookieConsent.locator('.cookie-consent-action-primary'))
  await feedbackBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await feedbackBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expectCenterHittable(feedbackClose)
  await expectCenterHittable(feedbackSubmit)

  await feedbackClose.click()
  await expect(feedbackPanel).toHaveCount(0)
  await expect(feedbackButton).toBeVisible()
  expect(await feedbackButton.evaluate((element) => document.activeElement === element)).toBe(true)

  await context.close()
})

test('desktop Feedback keeps the Compare and FAB controls usable', async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'one explicit desktop Chromium viewport is sufficient for this regression'
  )

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  await installSettingsFixture(page, 'en', 'accepted', 3)
  await page.goto('/groups', { waitUntil: 'domcontentloaded' })

  const fabButton = page.getByRole('button', { name: 'Create post', exact: true })
  const feedbackButton = page.getByRole('button', { name: 'Feedback', exact: true })
  const compareBar = page.locator('.compare-floating-bar')
  const compareToggle = compareBar.locator('.compare-floating-toggle')
  const compareClear = compareBar.locator('.compare-clear-button')
  const compareView = compareBar.locator('.compare-view-link')
  await expect(fabButton).toBeVisible({ timeout: 60_000 })
  await expect(feedbackButton).toBeVisible({ timeout: 60_000 })
  await expect(compareBar).toBeVisible({ timeout: 60_000 })
  await expect(compareClear).toBeVisible()
  await expect(compareView).toBeVisible()

  await feedbackButton.click()
  const feedbackPanel = page.locator('.feedback-panel')
  const feedbackClose = feedbackPanel.locator('.feedback-panel-close')
  await expect(feedbackPanel).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/has-feedback-panel/)
  await expect(fabButton).toBeVisible()
  await expect(compareBar).toBeVisible()
  await expect(feedbackButton).toBeVisible()
  expect(await feedbackClose.evaluate((element) => document.activeElement === element)).toBe(true)

  const [panelBox, fabBox, compareBox] = await Promise.all([
    feedbackPanel.boundingBox(),
    fabButton.boundingBox(),
    compareBar.boundingBox(),
  ])
  for (const box of [panelBox, fabBox, compareBox]) {
    expect(box).not.toBeNull()
    expectInsideViewport(box!, 1440, 900)
  }
  expect(intersectionArea(panelBox!, fabBox!)).toBe(0)
  expect(intersectionArea(panelBox!, compareBox!)).toBe(0)
  await expectCenterHittable(fabButton)
  await expectCenterHittable(compareToggle)
  await expectCenterHittable(compareClear)
  await expectCenterHittable(compareView)

  await fabButton.focus()
  expect(await fabButton.evaluate((element) => document.activeElement === element)).toBe(true)
  await compareToggle.focus()
  expect(await compareToggle.evaluate((element) => document.activeElement === element)).toBe(true)
  await compareView.focus()
  expect(await compareView.evaluate((element) => document.activeElement === element)).toBe(true)

  // Feedback -> FAB: keyboard activation transfers overlay ownership. The
  // closing Feedback panel must not steal focus back from the newly opened
  // menu, and Tab must advance through that menu naturally.
  await fabButton.focus()
  await page.keyboard.press('Enter')
  await expect(feedbackPanel).toHaveCount(0)
  const fabMenu = page.locator('.fab-menu')
  const fabMenuButtons = fabMenu.getByRole('button')
  await expect(fabMenu).toBeVisible()
  await expect(fabButton).toHaveAttribute('aria-expanded', 'true')
  await expect(fabMenuButtons).toHaveCount(2)
  expect(
    await fabMenuButtons.nth(0).evaluate((element) => document.activeElement === element)
  ).toBe(true)
  expect(await feedbackButton.evaluate((element) => document.activeElement === element)).toBe(false)
  await page.keyboard.press('Tab')
  expect(
    await fabMenuButtons.nth(1).evaluate((element) => document.activeElement === element)
  ).toBe(true)

  // Escape remains a self-close and must restore the FAB launcher.
  await page.keyboard.press('Escape')
  await expect(fabMenu).toHaveCount(0)
  expect(await fabButton.evaluate((element) => document.activeElement === element)).toBe(true)

  // FAB -> Feedback: Space opens the menu, then Space on Feedback transfers
  // ownership in the other direction. The FAB must not reclaim focus while the
  // new dialog focuses its close control, and Tab must enter the dialog body.
  await page.keyboard.press('Space')
  await expect(fabMenu).toBeVisible()
  expect(
    await fabMenuButtons.nth(0).evaluate((element) => document.activeElement === element)
  ).toBe(true)
  await feedbackButton.focus()
  await page.keyboard.press('Space')
  await expect(fabMenu).toHaveCount(0)
  await expect(fabButton).toHaveAttribute('aria-expanded', 'false')
  await expect(feedbackPanel).toBeVisible()
  expect(await feedbackClose.evaluate((element) => document.activeElement === element)).toBe(true)
  expect(await fabButton.evaluate((element) => document.activeElement === element)).toBe(false)
  await page.keyboard.press('Tab')
  const feedbackMessage = feedbackPanel.locator('textarea')
  expect(await feedbackMessage.evaluate((element) => document.activeElement === element)).toBe(true)

  // Escape remains a self-close and restores the Feedback launcher.
  await page.keyboard.press('Escape')
  await expect(feedbackPanel).toHaveCount(0)
  expect(await feedbackButton.evaluate((element) => document.activeElement === element)).toBe(true)
  await context.close()
})

test('groups FAB menu stays beside the persistent short-screen stack', async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'one explicit Chromium viewport is sufficient for the fixed stack'
  )

  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  await installSettingsFixture(page, 'en', 'accepted', 3, 34)
  await page.goto('/groups', { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: 'main { min-height: 1400px !important; }' })

  const fabButton = page.getByRole('button', { name: 'Create post', exact: true })
  const feedbackButton = page.getByRole('button', { name: 'Feedback', exact: true })
  const compareBar = page.locator('.compare-floating-bar')
  const compareToggle = compareBar.locator('.compare-floating-toggle')
  await expect(fabButton).toBeVisible({ timeout: 60_000 })
  await expect(feedbackButton).toBeVisible({ timeout: 60_000 })
  await expect(compareBar).toBeVisible({ timeout: 60_000 })

  await page.evaluate(() => window.scrollTo(0, 700))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
  const scrollToTop = page.getByRole('button', { name: 'Back to top', exact: true })
  await expect(scrollToTop).toBeVisible()

  await fabButton.click()
  const fabMenu = page.locator('.fab-menu')
  await expect(fabMenu).toBeVisible()
  await expect(fabButton).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(350)

  const [menuBox, compareBox, feedbackBox, scrollBox, fabBox] = await Promise.all([
    fabMenu.boundingBox(),
    compareBar.boundingBox(),
    feedbackButton.boundingBox(),
    scrollToTop.boundingBox(),
    fabButton.boundingBox(),
  ])
  for (const box of [menuBox, compareBox, feedbackBox, scrollBox, fabBox]) {
    expect(box).not.toBeNull()
    expectInsideViewport(box!, 320, 568)
  }
  for (const persistentBox of [compareBox!, feedbackBox!, scrollBox!, fabBox!]) {
    expect(intersectionArea(menuBox!, persistentBox)).toBe(0)
  }

  const fabMenuButtons = fabMenu.getByRole('button')
  await expect(fabMenuButtons).toHaveCount(2)
  await expectCenterHittable(fabMenuButtons.nth(0))
  await expectCenterHittable(fabMenuButtons.nth(1))
  await expectCenterHittable(fabButton)
  await expectCenterHittable(feedbackButton)
  await expectCenterHittable(scrollToTop)
  await expectCenterHittable(compareToggle)

  await fabMenuButtons.nth(0).focus()
  expect(
    await fabMenuButtons.nth(0).evaluate((element) => document.activeElement === element)
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(fabMenu).toHaveCount(0)
  await expect(fabButton).toHaveAttribute('aria-expanded', 'false')
  expect(await fabButton.evaluate((element) => document.activeElement === element)).toBe(true)

  // Opening Feedback explicitly owns the expanded-overlay slot and closes the
  // FAB menu rather than letting two panels reappear on top of one another.
  await fabButton.click()
  await expect(fabMenu).toBeVisible()
  await expect(fabButton).toHaveAttribute('aria-expanded', 'true')
  await feedbackButton.click()
  const feedbackPanel = page.locator('.feedback-panel')
  await expect(fabMenu).toHaveCount(0)
  await expect(feedbackPanel).toBeVisible()
  const panelBox = await feedbackPanel.boundingBox()
  expect(panelBox).not.toBeNull()
  expectInsideViewport(panelBox!, 320, 568)
  await expect(compareBar).toBeHidden()
  await expect(scrollToTop).toBeHidden()
  await expect(fabButton).toBeHidden()

  await feedbackPanel.locator('.feedback-panel-close').click()
  await expect(feedbackPanel).toHaveCount(0)
  await expect(fabButton).toBeVisible()
  await expect(compareBar).toBeVisible()
  await expect(scrollToTop).toBeVisible()
  await expect(feedbackButton).toBeVisible()
  await expect(fabButton).toHaveAttribute('aria-expanded', 'false')

  await context.close()
})
