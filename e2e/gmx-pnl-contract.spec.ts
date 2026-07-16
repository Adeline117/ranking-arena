import { expect, test, type Locator, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'

const GMX_TRADER = '0x1fa0152a66e390f049863a3d30772b9674cf3c92'
const WINDOW_TO = Date.UTC(2026, 6, 15) / 1000
const CUTOFF_ISO = new Date(WINDOW_TO * 1000).toISOString()

const VALUES = {
  7: { roi: 7.07, pnl: 70.07 },
  30: { roi: 30.3, pnl: 300.3 },
  90: { roi: 90.9, pnl: 900.9 },
} as const

const SUMMARY = 'Fees and price impact included · unrealized PnL excluded'
const PNL_LABEL = 'Realized Net PnL'
const ROI_LABEL = 'Realized ROI · Window Max Capital'

// The production PWA service worker can satisfy /core from an older cache
// before Playwright's page route sees the request. Block it so every assertion
// witnesses the deterministic v2 payload installed below, never stale prod data.
test.use({ serviceWorkers: 'block' })

async function expectVerifiedMetricLabels(scope: Page | Locator) {
  const pnlInfo = scope.getByRole('button', {
    name: /^GMX realized net PnL includes fees and price impact/,
  })
  const roiInfo = scope.getByRole('button', {
    name: /^GMX ROI is realized net PnL divided by maximum capital/,
  })

  await expect(pnlInfo).toBeVisible()
  await expect(pnlInfo.locator('..')).toContainText(PNL_LABEL)
  await expect(roiInfo).toBeVisible()
  await expect(roiInfo.locator('..')).toContainText(ROI_LABEL)
}

function coreModule(tf: keyof typeof VALUES) {
  return {
    timeframe: tf,
    stats: VALUES[tf],
    currency: 'USD',
    series: {},
    extras: {
      pnl_basis: 'gmx_period_realized_net',
      roi_basis: 'max_capital_usd',
      pnl_includes_unrealized: false,
      pnl_components_complete: true,
      profile_series_contract: 'unavailable_same_basis',
      profile_window_metrics_complete: true,
      window_semantics: 'completed_utc_days',
      window_from: WINDOW_TO - tf * 86_400,
      window_to: WINDOW_TO,
      window_duration_days: tf,
    },
    provenance: {
      source: 'gmx',
      asOf: '2026-07-15T00:05:00.000Z',
    },
    cacheState: 'warm',
  }
}

async function installDeterministicGmxResponses(page: Page) {
  await page.addInitScript(() => localStorage.setItem('language', 'en'))

  await page.route('**/api/traders/**/first-screen?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('source') !== 'gmx') {
      await route.continue()
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
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
              rank: 1,
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

  await page.route('**/api/traders/**/core?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('source') !== 'gmx') {
      await route.continue()
      return
    }

    const tf = Number(url.searchParams.get('tf'))
    if (tf !== 7 && tf !== 30 && tf !== 90) {
      await route.fulfill({ status: 400, body: 'unexpected timeframe' })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: coreModule(tf) }),
    })
  })
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

test.describe('GMX verified profile metric contract', () => {
  test.beforeEach(async ({ page }) => {
    await installDeterministicGmxResponses(page)
  })

  test('default three-tab layout keeps contract, values, cutoff and period in sync', async ({
    page,
  }) => {
    const failures = collectFirstPartyFailures(page)
    await openGmxProfile(page, '&period=90D')

    const card = page.locator('.performance-card').first()
    await expect(card).toBeVisible()
    await expectVerifiedMetricLabels(card)

    const note = card.getByRole('note', { name: SUMMARY })
    await expect(note).toBeVisible()
    await expect(note.locator('time')).toHaveAttribute('datetime', CUTOFF_ISO)
    await expect(card.getByText('+$900.90', { exact: true })).toBeVisible()
    await expect(card.getByText('+90.90%', { exact: true })).toBeVisible()

    const button7 = card.getByRole('button', { name: '7D period' })
    await button7.click()
    await expect(button7).toHaveAttribute('aria-pressed', 'true')
    await expect(page).toHaveURL(/(?:\?|&)period=7D(?:&|$)/)
    await expect(card.getByText('+$70.07', { exact: true })).toBeVisible()
    await expect(card.getByText('+7.07%', { exact: true })).toBeVisible()
    await expect(card.getByText('+$900.90', { exact: true })).toHaveCount(0)

    const button30 = card.getByRole('button', { name: '30D period' })
    await button30.click()
    await expect(button30).toHaveAttribute('aria-pressed', 'true')
    await expect(page).toHaveURL(/(?:\?|&)period=30D(?:&|$)/)
    await expect(card.getByText('+$300.30', { exact: true })).toBeVisible()
    await expect(card.getByText('+30.30%', { exact: true })).toBeVisible()
    await expect(note.locator('time')).toHaveAttribute('datetime', CUTOFF_ISO)

    const button90 = card.getByRole('button', { name: '90D period' })
    await button90.click()
    await expect(button90).toHaveAttribute('aria-pressed', 'true')
    await expect(page).toHaveURL((url) => url.searchParams.get('period') === null)
    await expect(card.getByText('+$900.90', { exact: true })).toBeVisible()
    expect(failures).toEqual([])
  })

  test('rollback panel preserves the same verified labels and selected-window data', async ({
    page,
  }) => {
    const failures = collectFirstPartyFailures(page)
    await openGmxProfile(page, '&threetab=0')

    const note = page.getByRole('note', { name: SUMMARY })
    await expect(note).toBeVisible()
    await expect(note.locator('time')).toHaveAttribute('datetime', CUTOFF_ISO)
    await expectVerifiedMetricLabels(page)
    await expect(page.getByText('+$900.9 USD', { exact: true })).toBeVisible()
    await expect(page.getByText('+90.90%', { exact: true })).toBeVisible()

    const button7 = page.getByRole('button', { name: '7D period' }).first()
    await button7.click()
    await expect(button7).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('+$70.07 USD', { exact: true })).toBeVisible()
    await expect(page.getByText('+7.07%', { exact: true })).toBeVisible()
    await expect(page.getByText('+$900.9 USD', { exact: true })).toHaveCount(0)

    const button30 = page.getByRole('button', { name: '30D period' }).first()
    await button30.click()
    await expect(button30).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('+$300.3 USD', { exact: true })).toBeVisible()
    await expect(page.getByText('+30.30%', { exact: true })).toBeVisible()
    await expect(note.locator('time')).toHaveAttribute('datetime', CUTOFF_ISO)
    expect(failures).toEqual([])
  })
})
