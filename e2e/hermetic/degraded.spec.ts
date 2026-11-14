import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * The core path when ranking data is missing, failing, old or partial. Each
 * test switches scripts/e2e/fake-supabase.mjs into one scenario and resets it,
 * so the page has to say what is wrong instead of rendering blank or invented
 * numbers. Expected copy comes from app/components/home/RankingSection.tsx,
 * RankingFooter.tsx and app/components/trader/TraderHeader.tsx.
 */
const FAKE_SUPABASE = 'http://127.0.0.1:54399'

type Scenario =
  | 'normal'
  | 'leaderboard-empty'
  | 'leaderboard-error'
  | 'leaderboard-stale-source'
  | 'leaderboard-stale-computed'

async function useScenario(request: APIRequestContext, name: Scenario) {
  const response = await request.post(`${FAKE_SUPABASE}/__e2e/scenario`, { data: { name } })
  expect(response.status(), `switch fake to ${name}`).toBe(200)
}

// A percentage or dollar figure in the ranking area would be a number the
// degraded data cannot support (for example a defaulted 0.0%).
const METRIC_FIGURE = /\d\s*%|\$\s*\d/

function rankingSection(page: Page) {
  return page.locator('#homepage-interactive .home-ranking-section:visible')
}

test.describe('degraded data', () => {
  test.afterEach(async ({ request }) => {
    await useScenario(request, 'normal')
  })

  test('an empty ranking says it is being refreshed, with no rows or figures', async ({
    page,
    request,
  }) => {
    await useScenario(request, 'leaderboard-empty')
    await page.goto('/')
    const section = rankingSection(page)
    // An empty cohort has no verified source watermark, so it is a refresh state.
    await expect(section).toContainText('Rankings are being refreshed')
    await expect(section.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
    await expect(section.locator('a[href*="/trader/"]')).toHaveCount(0)
    await expect(section).not.toContainText(METRIC_FIGURE)
  })

  test('a failing ranking says it failed and recovers on retry', async ({ page, request }) => {
    await useScenario(request, 'leaderboard-error')
    await page.goto('/')
    const section = rankingSection(page)
    await expect(section).toContainText('Failed to load rankings')
    await expect(section.locator('a[href*="/trader/"]')).toHaveCount(0)
    await expect(section).not.toContainText(METRIC_FIGURE)

    // The error is not a dead end: once the database answers, Retry loads rows.
    await useScenario(request, 'normal')
    await section.getByRole('button', { name: 'Retry' }).first().click()
    await expect(section.locator('a[href*="/trader/"]').first()).toContainText('E2E 90D Trader 1')
  })

  test('rankings built on days-old exchange data are withheld and marked delayed', async ({
    page,
    request,
  }) => {
    await useScenario(request, 'leaderboard-stale-source')
    await page.goto('/')
    const section = rankingSection(page)
    await expect(section).toContainText('Data may be delayed')
    await expect(section).toContainText('3 days ago')
    await expect(section.locator('a[href*="/trader/"]')).toHaveCount(0)
    await expect(section).not.toContainText(METRIC_FIGURE)
  })

  test('rankings whose scores were computed days ago are withheld', async ({ page, request }) => {
    await useScenario(request, 'leaderboard-stale-computed')
    await page.goto('/')
    const section = rankingSection(page)
    await expect(section).toContainText('Rankings are being refreshed')
    await expect(section).toContainText('Data may be delayed')
    await expect(section.locator('a[href*="/trader/"]')).toHaveCount(0)
    await expect(section).not.toContainText(METRIC_FIGURE)
  })

  test('a trader profile on days-old exchange data does not claim it was just updated', async ({
    page,
    request,
  }) => {
    await useScenario(request, 'leaderboard-stale-source')
    await page.goto('/trader/e2e-shared?platform=binance_futures')
    const header = page.locator('main')
    await expect(page.getByRole('heading', { name: 'E2E Shared Trader' })).toBeVisible()
    await expect(header).toContainText('Updated 3d ago')
    await expect(header).toContainText('Data may be delayed')
    await expect(header).not.toContainText(/Updated just now/i)
  })

  test('a trader that does not exist gets a not-found page, not an empty profile', async ({
    page,
  }) => {
    await page.goto('/trader/e2e-no-such-trader')
    const main = page.locator('main')
    await expect(main.getByText('Trader Not Found')).toBeVisible()
    await expect(main.getByRole('link', { name: 'Browse Rankings' })).toBeVisible()
    await expect(main).not.toContainText(METRIC_FIGURE)
  })

  test('a missing trader is not-found in the server HTML, not only after hydration', async ({
    request,
  }) => {
    const html = await (await request.get('/trader/e2e-no-such-trader')).text()
    expect(html).toContain('Trader Not Found')
    expect(html).toMatch(/<title>Trader Not Found \| Arena<\/title>/)
    expect(html).toContain('name="robots" content="noindex, nofollow"')
    expect(html).not.toContain('content="index, follow"')
    // A notFound() thrown after the shell streamed leaves only this digest for
    // the browser to act on (React error #419).
    expect(html).not.toContain('NEXT_HTTP_ERROR_FALLBACK')
  })

  test('a metric the source did not publish shows as unavailable, not as zero', async ({
    page,
  }) => {
    await page.goto('/trader/e2e-null-metrics?platform=binance_futures')
    await expect(page.getByRole('heading', { name: 'E2E Null Metrics Trader' })).toBeVisible()
    const overview = page.getByRole('tabpanel', { name: 'Overview' })
    // Published metrics still render, so the card itself is not just empty.
    await expect(overview.getByRole('img', { name: 'ROI +145.0%' })).toBeVisible()
    const sharpe = overview.locator('[title]').filter({ hasText: /^Sharpe/ })
    await expect(sharpe).toHaveCount(1)
    await expect(sharpe).toContainText('--')
    await expect(sharpe).not.toContainText(/\d/)
  })
})
