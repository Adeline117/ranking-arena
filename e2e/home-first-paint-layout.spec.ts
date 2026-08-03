import { expect, test, type Page } from '@playwright/test'

const AUTH_SLOT_WIDTH = 104
const MIN_NAV_EDGE = 8
const USER_ID = '22222222-2222-4222-8222-222222222222'
const FOUNDING_MEMBER_BANNER_HEIGHT = 31
const REQUIRE_FOUNDING_BANNER = process.env.E2E_REQUIRE_FOUNDING_BANNER === '1'

type TestLocale = 'en' | 'ja'

const FOUNDING_MEMBER_COPY: Record<TestLocale, { text: string; cta: string; dismiss: string }> = {
  en: {
    text: 'Founding Member — Lifetime access at $49.99',
    cta: 'Get it now',
    dismiss: 'Dismiss',
  },
  ja: {
    text: 'ファウンディングメンバー — $49.99で永久アクセス',
    cta: '今すぐ取得',
    dismiss: '閉じる',
  },
}

interface ElementSnapshot {
  x: number
  y: number
  width: number
  height: number
  right: number
  display: string
}

interface LayoutSnapshot {
  display: string
  columns: string
  rect: { x: number; y: number; width: number; height: number }
  leftDisplay: string | null
  centerRect: { x: number; width: number } | null
  rightDisplay: string | null
}

interface NavSnapshot {
  inner: ElementSnapshot | null
  innerPaddingRight: number
  logo: ElementSnapshot | null
  logoWord: ElementSnapshot | null
  actions: ElementSnapshot | null
  language: ElementSnapshot | null
  theme: ElementSnapshot | null
  auth: ElementSnapshot | null
  desktopSearch: ElementSnapshot | null
  mobileSearch: ElementSnapshot | null
  proSlot: ElementSnapshot | null
  documentClientWidth: number
  documentScrollWidth: number
  bodyScrollWidth: number
}

interface FoundingBannerSnapshot {
  banner: ElementSnapshot | null
  star: ElementSnapshot | null
  text: ElementSnapshot | null
  cta: ElementSnapshot | null
  dismiss: ElementSnapshot | null
  flexWrap: string
  overflow: string
  textWhiteSpace: string
  textOverflow: string
  ctaWhiteSpace: string
  ctaOverflow: string
  dismissPointerEvents: string
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function fakeSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
  return {
    access_token: `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({
      sub: USER_ID,
      exp: expiresAt,
      role: 'authenticated',
    })}.signature`,
    refresh_token: 'home-first-paint-layout-refresh-token',
    expires_in: 3600,
    expires_at: expiresAt,
    token_type: 'bearer',
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'home-layout@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: '2026-01-01T00:00:00.000Z',
    },
  }
}

async function readLayout(page: Page, selector: string): Promise<LayoutSnapshot> {
  return page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const left = element.querySelector<HTMLElement>(':scope > .three-col-left')
    const center = element.querySelector<HTMLElement>(':scope > .three-col-center')
    const right = element.querySelector<HTMLElement>(':scope > .three-col-right')
    const centerRect = center?.getBoundingClientRect()

    return {
      display: style.display,
      columns: style.gridTemplateColumns,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      leftDisplay: left ? getComputedStyle(left).display : null,
      centerRect: centerRect ? { x: centerRect.x, width: centerRect.width } : null,
      rightDisplay: right ? getComputedStyle(right).display : null,
    }
  })
}

async function readNav(page: Page): Promise<NavSnapshot> {
  return page.evaluate(() => {
    const snapshot = (element: Element | null): ElementSnapshot | null => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        display: getComputedStyle(element).display,
      }
    }
    const inner = document.querySelector('.top-nav-inner')

    return {
      inner: snapshot(inner),
      innerPaddingRight: inner ? Number.parseFloat(getComputedStyle(inner).paddingRight) : 0,
      logo: snapshot(document.querySelector('.top-nav-logo')),
      logoWord: snapshot(document.querySelector('.top-nav-logo-word')),
      actions: snapshot(document.querySelector('.top-nav-actions')),
      language: snapshot(document.querySelector('.top-nav-language-action')),
      theme: snapshot(document.querySelector('.top-nav-theme-action')),
      auth: snapshot(document.querySelector('.top-nav-auth-slot')),
      desktopSearch: snapshot(document.querySelector('.top-nav-search')),
      mobileSearch: snapshot(document.querySelector('.top-nav-actions > .show-mobile-flex')),
      proSlot: snapshot(document.querySelector('.top-nav-pro-slot')),
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }
  })
}

async function readFoundingBanner(page: Page): Promise<FoundingBannerSnapshot> {
  return page.getByTestId('founding-member-banner').evaluate((banner) => {
    const snapshot = (element: Element | null): ElementSnapshot | null => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        display: getComputedStyle(element).display,
      }
    }
    const text = banner.querySelector('[data-testid="founding-member-text"]')
    const cta = banner.querySelector('[data-testid="founding-member-cta"]')
    const dismiss = banner.querySelector('[data-testid="founding-member-dismiss"]')
    const bannerStyle = getComputedStyle(banner)
    const textStyle = text ? getComputedStyle(text) : null
    const ctaStyle = cta ? getComputedStyle(cta) : null
    const dismissStyle = dismiss ? getComputedStyle(dismiss) : null

    return {
      banner: snapshot(banner),
      star: snapshot(banner.querySelector('[data-testid="founding-member-star"]')),
      text: snapshot(text),
      cta: snapshot(cta),
      dismiss: snapshot(dismiss),
      flexWrap: bannerStyle.flexWrap,
      overflow: bannerStyle.overflow,
      textWhiteSpace: textStyle?.whiteSpace ?? '',
      textOverflow: textStyle?.textOverflow ?? '',
      ctaWhiteSpace: ctaStyle?.whiteSpace ?? '',
      ctaOverflow: ctaStyle?.overflow ?? '',
      dismissPointerEvents: dismissStyle?.pointerEvents ?? '',
    }
  })
}

function requiredRect(
  value: ElementSnapshot | null,
  name: string
): asserts value is ElementSnapshot {
  expect(value, `${name} must exist`).not.toBeNull()
}

function expectSameRect(
  before: ElementSnapshot | null,
  after: ElementSnapshot | null,
  name: string
) {
  requiredRect(before, `${name} before hydration`)
  requiredRect(after, `${name} after hydration`)
  expect(after.x, `${name} x`).toBeCloseTo(before.x, 0)
  expect(after.y, `${name} y`).toBeCloseTo(before.y, 0)
  expect(after.width, `${name} width`).toBeCloseTo(before.width, 0)
  expect(after.height, `${name} height`).toBeCloseTo(before.height, 0)
}

function expectSameOptionalRect(
  before: ElementSnapshot | null,
  after: ElementSnapshot | null,
  name: string
) {
  expect(Boolean(after), `${name} presence`).toBe(Boolean(before))
  if (before && after) expectSameRect(before, after, name)
}

function expectSameLayoutGeometry(before: LayoutSnapshot, after: LayoutSnapshot) {
  expect(after.rect.x).toBeCloseTo(before.rect.x, 0)
  expect(after.rect.y).toBeCloseTo(before.rect.y, 0)
  expect(after.rect.width).toBeCloseTo(before.rect.width, 0)
  expect(after.centerRect?.x).toBeCloseTo(before.centerRect?.x ?? Number.NaN, 0)
  expect(after.centerRect?.width).toBeCloseTo(before.centerRect?.width ?? Number.NaN, 0)
}

function expectResponsiveNavBounds(nav: NavSnapshot, viewportWidth: number) {
  requiredRect(nav.inner, 'top nav inner')
  requiredRect(nav.logo, 'top nav logo')
  requiredRect(nav.actions, 'top nav actions')
  requiredRect(nav.auth, 'top nav auth slot')
  requiredRect(nav.language, 'top nav language action')
  requiredRect(nav.theme, 'top nav theme action')
  requiredRect(nav.logoWord, 'top nav logo word')
  requiredRect(nav.desktopSearch, 'top nav desktop search')
  requiredRect(nav.mobileSearch, 'top nav mobile search')

  expect(nav.documentClientWidth).toBe(viewportWidth)
  expect(nav.documentScrollWidth).toBe(nav.documentClientWidth)
  expect(nav.bodyScrollWidth).toBeLessThanOrEqual(nav.documentClientWidth)
  expect(nav.actions.right).toBeLessThanOrEqual(viewportWidth - MIN_NAV_EDGE)
  expect(nav.actions.right).toBeLessThanOrEqual(nav.inner.right - nav.innerPaddingRight + 0.5)
  expect(nav.actions.x - nav.logo.right).toBeGreaterThanOrEqual(MIN_NAV_EDGE - 0.5)
  expect(nav.auth.width).toBeCloseTo(AUTH_SLOT_WIDTH, 0)

  const compact = viewportWidth <= 400
  const symbolOnly = viewportWidth <= 360
  expect(nav.theme.display).toBe(compact ? 'none' : 'block')
  expect(nav.logoWord.display).toBe(symbolOnly ? 'none' : 'block')
  expect(nav.desktopSearch.display).toBe(viewportWidth < 768 ? 'none' : 'flex')
  expect(nav.mobileSearch.display).toBe(viewportWidth < 768 ? 'flex' : 'none')
}

function expectFoundingBannerBounds(snapshot: FoundingBannerSnapshot) {
  requiredRect(snapshot.banner, 'founding-member banner')
  expect(snapshot.banner.height).toBeCloseTo(FOUNDING_MEMBER_BANNER_HEIGHT, 0)
  expect(snapshot.flexWrap).toBe('nowrap')
  expect(snapshot.overflow).toBe('hidden')
  expect(snapshot.textWhiteSpace).toBe('nowrap')
  expect(snapshot.textOverflow).toBe('ellipsis')
  expect(snapshot.ctaWhiteSpace).toBe('nowrap')
  expect(snapshot.ctaOverflow).toBe('hidden')
  expect(snapshot.dismissPointerEvents).not.toBe('none')

  const children = [
    ['star', snapshot.star],
    ['localized text', snapshot.text],
    ['CTA', snapshot.cta],
    ['dismiss button', snapshot.dismiss],
  ] as const

  for (const [name, child] of children) {
    requiredRect(child, `founding-member ${name}`)
    expect(child.display, `${name} display`).not.toBe('none')
    expect(child.width, `${name} width`).toBeGreaterThan(0)
    expect(child.height, `${name} height`).toBeGreaterThan(0)
    expect(child.x, `${name} left bound`).toBeGreaterThanOrEqual(snapshot.banner.x - 0.5)
    expect(child.right, `${name} right bound`).toBeLessThanOrEqual(snapshot.banner.right + 0.5)
    expect(child.y, `${name} top bound`).toBeGreaterThanOrEqual(snapshot.banner.y - 0.5)
    expect(child.y + child.height, `${name} bottom bound`).toBeLessThanOrEqual(
      snapshot.banner.y + snapshot.banner.height + 0.5
    )
  }

  requiredRect(snapshot.star, 'founding-member star')
  requiredRect(snapshot.text, 'founding-member localized text')
  requiredRect(snapshot.cta, 'founding-member CTA')
  requiredRect(snapshot.dismiss, 'founding-member dismiss button')
  expect(snapshot.star.right).toBeLessThanOrEqual(snapshot.text.x + 0.5)
  expect(snapshot.text.right).toBeLessThanOrEqual(snapshot.cta.x + 0.5)
  expect(snapshot.cta.right).toBeLessThanOrEqual(snapshot.dismiss.x + 0.5)
}

async function installBrowserState(page: Page, authenticated: boolean, locale: TestLocale) {
  await page.addInitScript(
    ({ session, savedLocale }) => {
      localStorage.setItem('cookie_consent', 'accepted')
      localStorage.setItem('language', savedLocale)
      localStorage.removeItem('founding-banner-dismissed')
      if (session) localStorage.setItem('arena-auth', JSON.stringify(session))
      else localStorage.removeItem('arena-auth')
    },
    { session: authenticated ? fakeSession() : null, savedLocale: locale }
  )

  // Make browser-side data reads deterministic. This test owns layout/CLS,
  // including the truthful no-data handoff; a real backend outage must not
  // consume its whole viewport matrix through stacked 10-20 second timeouts.
  await page.route('**/rest/v1/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-range': '0-0/*' },
      body: '[]',
    })
  })
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/subscription') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return
    }
    if (pathname === '/api/track') {
      await route.fulfill({ status: 204, body: '' })
      return
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'E2E_BACKEND_UNAVAILABLE' }),
    })
  })
}

test.describe('homepage first-paint layout handoff', () => {
  test('keeps nav and page geometry stable for every narrow-screen auth state', async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'The desktop project owns the explicit desktop/mobile first-paint matrix'
    )
    test.setTimeout(120_000)

    const viewports = [
      { name: 'desktop-1440', width: 1440, height: 1000, columns: 3 },
      { name: 'mobile-390', width: 390, height: 844, columns: 1 },
      { name: 'mobile-361', width: 361, height: 800, columns: 1 },
      { name: 'mobile-320', width: 320, height: 700, columns: 1 },
    ] as const
    const authStates = [
      { name: 'anonymous', authenticated: false, locale: 'en' },
      { name: 'authenticated', authenticated: true, locale: 'ja' },
    ] as const

    for (const viewport of viewports) {
      for (const authState of authStates) {
        const locale: TestLocale = viewport.columns === 1 ? authState.locale : 'en'
        const scenarioName = `${viewport.name}-${authState.name}-${locale}`
        await test.step(scenarioName, async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: 'light',
            serviceWorkers: 'block',
          })
          const page = await context.newPage()
          await installBrowserState(page, authState.authenticated, locale)

          let releaseChunks = () => {}
          const chunkGate = new Promise<void>((resolve) => {
            releaseChunks = resolve
          })

          await page.addInitScript(() => {
            ;(
              window as typeof window & {
                __arenaLayoutShift?: number
              }
            ).__arenaLayoutShift = 0
            new PerformanceObserver((list) => {
              for (const rawEntry of list.getEntries()) {
                const entry = rawEntry as PerformanceEntry & {
                  hadRecentInput?: boolean
                  value?: number
                }
                if (!entry.hadRecentInput) {
                  const owner = window as typeof window & {
                    __arenaLayoutShift?: number
                  }
                  owner.__arenaLayoutShift = (owner.__arenaLayoutShift ?? 0) + (entry.value ?? 0)
                }
              }
            }).observe({ type: 'layout-shift', buffered: true })
          })

          await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
            await chunkGate
            await route.continue()
          })

          try {
            await page.goto('/', { waitUntil: 'commit' })
            await expect(page.locator('#ssr-home-content-shell')).toBeVisible({
              timeout: 15_000,
            })
            await expect(page.locator('.top-nav-actions')).toBeVisible()
            await page.evaluate(() => document.fonts.ready)

            const beforeLayout = await readLayout(page, '#ssr-ranking-table')
            const beforeNav = await readNav(page)
            const reservesProSlot = beforeNav.proSlot !== null
            if (REQUIRE_FOUNDING_BANNER) {
              expect(
                reservesProSlot,
                'E2E_REQUIRE_FOUNDING_BANNER requires a post-promo production build'
              ).toBe(true)
            }
            expectResponsiveNavBounds(beforeNav, viewport.width)
            const firstPaintSourceStrip = page.getByTestId('first-paint-source-strip')
            if (viewport.width < 768) await expect(firstPaintSourceStrip).toBeHidden()
            else await expect(firstPaintSourceStrip).toBeVisible()
            await expect(
              page.getByTestId('top-nav-auth-slot').locator(':scope > .skeleton')
            ).toBeVisible()
            if (reservesProSlot) {
              await expect(page.getByTestId('top-nav-pro-fallback')).toBeAttached()
              await expect(page.getByTestId('first-paint-founding-member-slot')).toBeAttached()
            } else {
              await expect(page.getByTestId('top-nav-pro-fallback')).toHaveCount(0)
              await expect(page.getByTestId('first-paint-founding-member-slot')).toHaveCount(0)
            }

            if (viewport.columns === 3) {
              expect(beforeLayout.display).toBe('grid')
              expect(beforeLayout.columns.trim().split(/\s+/)).toHaveLength(3)
              expect(beforeLayout.leftDisplay).not.toBe('none')
              expect(beforeLayout.rightDisplay).not.toBe('none')
              await expect(page.getByTestId('top-nav-search-fallback')).toBeVisible()
              await expect(page.getByTestId('mobile-search-button-fallback')).toBeHidden()
            } else {
              expect(beforeLayout.display).toBe('block')
              expect(beforeLayout.leftDisplay).toBe('none')
              expect(beforeLayout.rightDisplay).toBe('none')
              await expect(page.getByTestId('top-nav-search-fallback')).toBeHidden()
              await expect(page.getByTestId('mobile-search-button-fallback')).toBeVisible()
            }

            if (authState.name === 'anonymous') {
              await testInfo.attach(`${viewport.name}-first-paint`, {
                body: await page.screenshot({ fullPage: false }),
                contentType: 'image/png',
              })
            }

            releaseChunks()

            if (authState.authenticated) {
              await expect(page.locator('[data-inbox-trigger]')).toBeVisible({
                timeout: 30_000,
              })
            } else {
              await expect(page.locator('.top-nav-login-link')).toBeVisible({
                timeout: 30_000,
              })
            }
            if (viewport.width >= 768) {
              await expect(page.locator('.top-nav-search-input')).toBeVisible()
            } else {
              await expect(page.locator('button.show-mobile-flex')).toBeVisible()
            }
            if (reservesProSlot) {
              const proButton = page.getByTestId('top-nav-pro-button')
              if (viewport.width >= 768) await expect(proButton).toBeVisible()
              else await expect(proButton).toBeHidden()
              await expect(page.getByTestId('top-nav-pro-fallback')).toHaveCount(0)
              const copy = FOUNDING_MEMBER_COPY[locale]
              await expect(page.getByTestId('founding-member-banner')).toBeVisible()
              await expect(page.getByTestId('founding-member-text')).toHaveText(copy.text)
              await expect(page.getByTestId('founding-member-cta')).toHaveText(copy.cta)
              await expect(page.getByTestId('founding-member-dismiss')).toHaveAccessibleName(
                copy.dismiss
              )
              await expect(page.getByTestId('founding-member-dismiss')).toBeEnabled()
            } else {
              await expect(page.getByTestId('top-nav-pro-button')).toHaveCount(0)
              await expect(page.locator('.founding-member-banner')).toHaveCount(0)
            }
            await expect(
              page.locator('#homepage-interactive .three-col-layout').first()
            ).toBeVisible({ timeout: 30_000 })
            await expect(page.locator('#homepage-interactive')).toHaveAttribute(
              'data-home-ready',
              'true'
            )
            await expect(page.locator('#ssr-home-content-shell')).toBeHidden()
            const interactiveSourceStrip = page.getByTestId('interactive-source-strip')
            if (viewport.width < 768) await expect(interactiveSourceStrip).toBeHidden()
            else await expect(interactiveSourceStrip).toBeVisible()
            await page.waitForTimeout(750)

            const afterLayout = await readLayout(page, '#homepage-interactive .three-col-layout')
            const afterNav = await readNav(page)
            const foundingBanner = reservesProSlot ? await readFoundingBanner(page) : null
            if (foundingBanner) expectFoundingBannerBounds(foundingBanner)
            expectSameLayoutGeometry(beforeLayout, afterLayout)
            expectResponsiveNavBounds(afterNav, viewport.width)
            expectSameRect(beforeNav.actions, afterNav.actions, 'top nav actions')
            expectSameRect(beforeNav.auth, afterNav.auth, 'auth slot')
            expectSameRect(beforeNav.language, afterNav.language, 'language action')
            expectSameRect(beforeNav.desktopSearch, afterNav.desktopSearch, 'desktop search')
            expectSameRect(beforeNav.mobileSearch, afterNav.mobileSearch, 'mobile search')
            expectSameOptionalRect(beforeNav.theme, afterNav.theme, 'theme action')
            expectSameOptionalRect(beforeNav.proSlot, afterNav.proSlot, 'Go Pro slot')

            const cls = await page.evaluate(
              () =>
                (
                  window as typeof window & {
                    __arenaLayoutShift?: number
                  }
                ).__arenaLayoutShift ?? 0
            )
            expect(cls).toBeLessThan(0.05)

            await testInfo.attach(`${scenarioName}-layout-metrics`, {
              body: Buffer.from(
                JSON.stringify(
                  {
                    viewport: { width: viewport.width, height: viewport.height },
                    authState: authState.name,
                    locale,
                    serverShell: beforeLayout,
                    interactiveLayout: afterLayout,
                    navBefore: beforeNav,
                    navAfter: afterNav,
                    foundingBanner,
                    cumulativeLayoutShift: cls,
                  },
                  null,
                  2
                )
              ),
              contentType: 'application/json',
            })

            if (authState.name === 'anonymous') {
              await testInfo.attach(`${viewport.name}-hydrated`, {
                body: await page.screenshot({ fullPage: false }),
                contentType: 'image/png',
              })
            }
            if (reservesProSlot && viewport.columns === 1 && locale === 'ja') {
              await testInfo.attach(`${viewport.name}-ja-founding-banner`, {
                body: await page.getByTestId('founding-member-banner').screenshot(),
                contentType: 'image/png',
              })
            }

            if (reservesProSlot) {
              await page.getByTestId('founding-member-dismiss').click()
              await expect(page.getByTestId('founding-member-banner')).toHaveCount(0)
              await expect(page.getByTestId('interactive-founding-member-slot')).toHaveCSS(
                'height',
                `${FOUNDING_MEMBER_BANNER_HEIGHT}px`
              )
              await expect
                .poll(() => page.evaluate(() => localStorage.getItem('founding-banner-dismissed')))
                .toBe('1')
              const afterDismissLayout = await readLayout(
                page,
                '#homepage-interactive .three-col-layout'
              )
              expectSameLayoutGeometry(afterLayout, afterDismissLayout)
            }
          } finally {
            releaseChunks()
            await context.close()
          }
        })
      }
    }
  })
})
