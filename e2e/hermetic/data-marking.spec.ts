import { test, expect } from './fixtures'

/**
 * What a reader sees for rows the relaxed eligibility rule lets onto the board
 * (scripts/e2e/fake-supabase.mjs):
 *  - "E2E Partial Trader": no win rate, and a drawdown that was refused. Both
 *    are EMPTY, so they render as "—" — never as 0 or 0%.
 *  - "E2E Idle Trader": no ROI and no PnL in the period. Hidden from the list
 *    by default, counted at the end of it, shown with a "no trading" label
 *    once expanded, absent from the sitemap, and not indexable.
 */
type ApiTrader = Record<string, unknown>

async function listTraders(
  request: import('@playwright/test').APIRequestContext,
  query: string
): Promise<ApiTrader[]> {
  const response = await request.get(`/api/traders?timeRange=90D&limit=200${query}`)
  expect(response.status()).toBe(200)
  const body = (await response.json()) as {
    data?: { traders?: ApiTrader[] }
    traders?: ApiTrader[]
  }
  return body.data?.traders ?? body.traders ?? []
}

const byHandle = (traders: ApiTrader[], handle: string) =>
  traders.find((trader) => trader.handle === handle)

test.describe('rows with missing metrics and idle-window rows', () => {
  test('the list API keeps missing metrics empty and hides idle rows unless asked', async ({
    request,
    isMobile,
  }) => {
    test.skip(isMobile, 'raw requests do not depend on the viewport')
    const listed = await listTraders(request, '')
    expect(byHandle(listed, 'E2E Idle Trader')).toBeUndefined()
    expect(byHandle(listed, 'E2E Partial Trader')).toMatchObject({
      win_rate: null,
      max_drawdown: null,
      mdd_contradiction: true,
      idle_window: false,
    })

    const withIdle = await listTraders(request, '&idle=1')
    expect(byHandle(withIdle, 'E2E Idle Trader')).toMatchObject({
      idle_window: true,
      win_rate: null,
      max_drawdown: null,
    })
    expect(withIdle.length).toBe(listed.length + 1)

    const count = await request.get('/api/traders/idle-count?timeRange=90D')
    expect(count.status()).toBe(200)
    expect(((await count.json()) as { data: { count: number } }).data.count).toBe(1)
  })

  test('an idle account is not in the sitemap and its profile is not indexable', async ({
    request,
    isMobile,
  }) => {
    test.skip(isMobile, 'raw requests do not depend on the viewport')
    const shard = await (await request.get('/api/sitemap-xml?shard=1')).text()
    expect(shard).not.toContain('/trader/e2e-idle?')
    expect(shard).toContain('/trader/e2e-partial?')

    const robots = async (path: string) => {
      const html = await (await request.get(path)).text()
      return html.match(/<meta[^>]*name="robots"[^>]*>/)?.[0] ?? ''
    }
    expect(await robots('/trader/e2e-idle?platform=binance_futures')).toContain('noindex')
    // Missing metrics alone do not make a profile unindexable.
    expect(await robots('/trader/e2e-partial?platform=binance_futures')).not.toContain('noindex')
  })

  test('the board shows "—" for missing metrics and expands the idle tail on request', async ({
    page,
  }) => {
    await page.goto('/')
    const rows = page.locator('#homepage-interactive a[href*="/trader/"]:visible')
    const partial = rows.filter({ hasText: 'E2E Partial Trader' })
    await expect(partial).toHaveCount(1)
    // A missing win rate / drawdown must not be printed as a zero percentage.
    await expect(partial).not.toContainText(/(^|[^\d.+-])0(\.0+)?%/)

    await expect(rows.filter({ hasText: 'E2E Idle Trader' })).toHaveCount(0)
    const tail = page.getByTestId('idle-window-tail')
    await expect(tail).toContainText('1 more accounts with no trading this period')

    await tail.getByRole('button', { name: 'Show' }).click()
    const idle = rows.filter({ hasText: 'E2E Idle Trader' })
    await expect(idle).toHaveCount(1)
    await expect(idle).toContainText('No trading this period')
    await expect(page).toHaveURL(/[?&]idle=1/)

    await page.getByTestId('idle-window-tail').getByRole('button').click()
    await expect(rows.filter({ hasText: 'E2E Idle Trader' })).toHaveCount(0)
  })
})
