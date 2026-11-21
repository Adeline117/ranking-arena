import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './fixtures'

/**
 * The trader profile's server-rendered summary (TraderServerSummary) exists so
 * that a crawler, which runs no script and cannot call /api/*, still receives
 * the trader's numbers and links to other traders. These tests read the raw
 * response the way a crawler does, then check the block survives hydration and
 * capture it for visual review (uploaded by CI as `trader-summary-screenshots`).
 */
const PROFILE = '/trader/e2e-shared?platform=binance_futures'
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const SCREENSHOT_DIR = path.resolve(__dirname, '../../e2e-screenshots')

test.describe('trader profile server summary', () => {
  test('the raw HTML a crawler receives carries the numbers and trader links', async ({
    request,
    isMobile,
  }) => {
    test.skip(isMobile, 'a raw request does not depend on the viewport')
    const response = await request.get(PROFILE, { headers: { 'user-agent': GOOGLEBOT } })
    expect(response.status()).toBe(200)
    const html = await response.text()

    // Googlebot must get the canonical in <head>, pointing at the account URL.
    const head = html.slice(0, html.indexOf('</head>'))
    const canonical = head.match(/<link[^>]*rel="canonical"[^>]*>/)?.[0] ?? ''
    expect(canonical).toContain('/trader/e2e-shared?platform=binance_futures"')
    expect(head).not.toMatch(/<meta[^>]*name="robots"[^>]*noindex/)

    const start = html.indexOf('aria-labelledby="trader-summary-heading"')
    expect(start, 'summary section present in server HTML').toBeGreaterThan(-1)
    const summary = html.slice(start, html.indexOf('</section>', start))
    expect(summary).toContain('E2E Shared Trader')
    expect(summary).toContain('#31') // fixture rank
    expect(summary).toContain('+333.0%') // 90D ROI
    expect(summary).toContain('+$200.0K') // 90D PnL
    // Similar traders are real anchors to canonical account URLs.
    expect(summary).toMatch(/<a href="\/trader\/e2e-90d-\d+\?platform=binance_futures"/)
  })

  for (const theme of ['dark', 'light'] as const) {
    test(`the summary stays visible after hydration (${theme})`, async ({ page }, testInfo) => {
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
      await page.goto(PROFILE)
      // A client-rendered number proves the page hydrated before we look.
      await expect(
        page.getByRole('tabpanel', { name: 'Overview' }).getByRole('img', { name: 'ROI +333.0%' })
      ).toBeVisible()

      const summary = page.getByRole('region', { name: 'At a glance' })
      await summary.scrollIntoViewIfNeeded()
      await expect(summary).toBeVisible()
      await expect(summary.getByText('+333.0%')).toBeVisible()
      await expect(summary.getByRole('link').first()).toBeVisible()

      mkdirSync(SCREENSHOT_DIR, { recursive: true })
      const name = `trader-summary-${testInfo.project.name}-${theme}`
      await summary.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) })
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-viewport.png`) })
    })
  }
})
