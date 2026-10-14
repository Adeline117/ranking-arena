import { expect, test, type Locator, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'

const GMX_TRADER = '0x1fa0152a66e390f049863a3d30772b9674cf3c92'

const VALUES = {
  7: { roi: 7.07, pnl: 70.07 },
  30: { roi: 30.3, pnl: 300.3 },
  90: { roi: 90.9, pnl: 900.9 },
} as const

// Distinct per-timeframe ranks so each assertion witnesses the exact entry.
const RANKS = { 7: 3, 30: 2, 90: 1 } as const

// The public /core projection is quarantined for every timeframe
// (lib/data/serving/core-quarantine.ts); the client builds that static
// projection locally and must not request /core at all. Block the PWA service
// worker so a stale cached /core response cannot mask a regression.
test.use({ serviceWorkers: 'block' })

async function expectSealedRanking(scope: Page | Locator, tf: keyof typeof VALUES) {
  const notice = scope.getByTestId('history-verification-notice').first()
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Historical data under verification')
  await expect(notice.getByText(`#${RANKS[tf]}`, { exact: true })).toBeVisible()
  const roiText = `+${VALUES[tf].roi.toFixed(2)}%`
  await expect(notice.getByText(roiText, { exact: true })).toBeVisible()
  // Quarantined history never surfaces PnL or the GMX realized-PnL contract.
  await expect(notice).not.toContainText('$')
  await expect(scope.getByText('Realized Net PnL')).toHaveCount(0)
}

async function installDeterministicGmxResponses(page: Page): Promise<string[]> {
  await page.addInitScript(() => localStorage.setItem('language', 'en'))

  await page.route('**/api/traders/**/first-screen?*', async (route) => {
    const url = new URL(route.request().url())
    const requestedPlatform = url.searchParams.get('source')
    if (requestedPlatform !== 'gmx') {
      await route.continue()
      return
    }
    const requestedHandle = decodeURIComponent(url.pathname.split('/').at(-2) ?? '')
    expect(requestedHandle).toBe(GMX_TRADER)

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          request: { platform: requestedPlatform, handle: requestedHandle },
          subject: { platform: 'gmx', traderKey: GMX_TRADER },
          firstScreen: {
            source: 'gmx',
            exchangeTraderId: GMX_TRADER,
            nickname: 'GMX contract witness',
            avatarMirrorUrl: null,
            avatarOriginUrl: null,
            avatarSrc: null,
            walletAddress: GMX_TRADER,
            traderKind: 'human',
            botStrategy: null,
            entries: ([7, 30, 90] as const).map((timeframe) => ({
              timeframe,
              rank: RANKS[timeframe],
              rankingVisibility: 'verified',
              rankingVisibilityReason: null,
              headlineRoi: VALUES[timeframe].roi,
              headlinePnl: { value: VALUES[timeframe].pnl, currency: 'USD' },
              headlineWinRate: null,
              extras: {},
              provenance: { source: 'gmx', asOf: '2026-07-15T00:05:00.000Z' },
            })),
          },
          capability: {
            timeframes: { '7': 'native', '30': 'native', '90': 'native' },
            inceptionTf: false,
            metrics: ['roi', 'pnl'],
            surfaces: {
              positions: false,
              position_history: false,
              orders: false,
              transfers: false,
              copiers: false,
            },
            copierDepth: 'none',
            currency: 'USD',
            isOnchain: true,
            derivedBoardNote: false,
            exchangeName: 'GMX',
          },
          is_verified_data: false,
        },
      }),
    })
  })

  const coreCalls: string[] = []
  await page.route(/\/api\/traders\/[^/]+\/core(?:\?|$)/, async (route) => {
    coreCalls.push(route.request().url())
    await route.fulfill({ status: 410, body: 'quarantined /core must not be requested' })
  })
  return coreCalls
}

function collectFirstPartyFailures(page: Page) {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() < 500) return
    const responseUrl = new URL(response.url())
    const pageUrl = new URL(page.url())
    if (responseUrl.origin === pageUrl.origin) {
      failures.push(`${response.status()} ${responseUrl.pathname}`)
    }
  })
  return failures
}

async function openGmxProfile(page: Page, suffix: string) {
  const response = await page.goto(`/trader/${GMX_TRADER}?platform=gmx${suffix}`, {
    waitUntil: 'domcontentloaded',
  })
  expect(response?.status()).toBe(200)
  await dismissOverlays(page)
}

test.describe('GMX profile under history quarantine', () => {
  let coreCalls: string[] = []

  test.beforeEach(async ({ page }) => {
    coreCalls = await installDeterministicGmxResponses(page)
  })

  test('default three-tab layout shows the verification notice with sealed rank/ROI', async ({
    page,
  }) => {
    const failures = collectFirstPartyFailures(page)
    await openGmxProfile(page, '&period=90D')

    await expectSealedRanking(page, 90)
    await expect(page.locator('.performance-card')).toHaveCount(0)

    await openGmxProfile(page, '&period=7D')
    await expectSealedRanking(page, 7)
    await expect(page.getByText(`#${RANKS[90]}`, { exact: true })).toHaveCount(0)

    expect(coreCalls).toEqual([])
    expect(failures).toEqual([])
  })

  test('rollback panel switches periods without requesting /core', async ({ page }) => {
    const failures = collectFirstPartyFailures(page)
    await openGmxProfile(page, '&threetab=0')

    await expectSealedRanking(page, 90)

    const button7 = page.getByRole('button', { name: '7D period' }).first()
    await button7.click()
    await expect(button7).toHaveAttribute('aria-pressed', 'true')
    await expectSealedRanking(page, 7)

    const button30 = page.getByRole('button', { name: '30D period' }).first()
    await button30.click()
    await expect(button30).toHaveAttribute('aria-pressed', 'true')
    await expectSealedRanking(page, 30)

    expect(coreCalls).toEqual([])
    expect(failures).toEqual([])
  })
})
