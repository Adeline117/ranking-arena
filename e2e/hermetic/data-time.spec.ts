import { test, expect } from './fixtures'

/**
 * Data-time honesty on the core path. The fake Supabase serves a fresh source
 * watermark, so these cases cover the healthy path; stale/unknown branches are
 * covered by unit tests (RankingControls, ProvenanceFooter, PeriodSelector,
 * structured-data) until the degraded-scenario switch from #406 lands.
 */
test.describe('data time honesty', () => {
  test('homepage "Data as of" is a machine-readable source time with no delay flag', async ({
    page,
  }) => {
    await page.goto('/')
    // Two "Data as of" times exist: the SSR shell's copy (hidden once the client
    // ranking hydrates) and the client footer's. Which one is first in the DOM
    // says nothing about what the visitor sees, so assert on the visible one.
    const asOf = page
      .locator('time', { hasText: /^Data as of / })
      .filter({ visible: true })
      .first()
    await expect(asOf).toBeVisible()
    const dateTime = await asOf.getAttribute('datetime')
    expect(dateTime).not.toBeNull()
    expect(Number.isFinite(Date.parse(dateTime as string))).toBe(true)
    await expect(page.getByTestId('ranking-data-stale')).toHaveCount(0)
  })

  test('trader structured data does not claim the render time as dateModified', async ({
    page,
  }) => {
    await page.goto('/trader/e2e-shared?platform=binance_futures')
    await expect(page.getByRole('heading', { name: 'E2E Shared Trader' })).toBeVisible()
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents()
    const profilePages = blocks
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .filter((data) => data['@type'] === 'ProfilePage')
    expect(profilePages.length).toBeGreaterThan(0)
    for (const profile of profilePages) expect(profile).not.toHaveProperty('dateModified')
  })
})
