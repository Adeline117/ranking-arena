/**
 * E2E tests for trader-detail linked-account switching.
 *
 * Linked membership is a privacy-sensitive live relation. It must come from
 * the standalone, exact subject-bound contract-v2 endpoint and must never be
 * bundled into the longer-lived trader-detail response.
 *
 * Public data rarely contains a stable multi-account fixture, so membership
 * and the synthetic secondary account's serving contracts are mocked in the
 * browser. The real route still provides the primary identity and the page
 * executes its production account-scope state machine end to end.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import { dismissOverlays } from './helpers'

const MOCK_LINKED_PLATFORM = 'bybit'
const MOCK_FALLBACK_LINKED_PLATFORM = 'binance_futures'
const MOCK_LINKED_KEY = 'mock-linked-fixture'
const MOCK_CANONICAL_LINKED_PLATFORM = 'synthetic_serving'
const MOCK_TOP_LEVEL_LEGACY_PLATFORM = 'mock_legacy_override'
const MOCK_TOP_LEVEL_LEGACY_NAME = 'Legacy Override B'
const MOCK_TOP_LEVEL_LEGACY_ROI_TEXT = '+42.42%'
const MOCK_LINKED_LABEL = 'Synthetic Secondary'
const MOCK_LINKED_NAME = 'Synthetic Secondary Profile'
const MOCK_PRIMARY_ROI = 180.5
const MOCK_LINKED_ROI = 95.2
const MOCK_LINKED_RANK = 742
const MOCK_LINKED_ROI_TEXT = '+95.20%'

interface LinkedSubject {
  platform: string
  traderKey: string
}

interface StandaloneAggregateCall {
  url: string
  subject: LinkedSubject
}

interface FirstScreenCall {
  url: string
  request: LinkedSubject
  canonicalSubject: LinkedSubject
}

interface LinkedAccountRequests {
  aggregateCalls: StandaloneAggregateCall[]
  firstScreenCalls: FirstScreenCall[]
  /** Any /core request is a regression: the projection is quarantined and built client-side. */
  coreCalls: string[]
  legacyCalls: string[]
  invalidCalls: string[]
  controls: {
    firstScreenLiveRequestStarted: Promise<void>
    releaseFirstScreenLiveRequest: () => void
    aggregatePendingRequestStarted: Promise<void>
    releaseAggregatePendingRequest: () => void
  }
}

interface LinkedApiFixtureOptions {
  accountCount?: 2 | 4
  firstScreenScenario?:
    | 'success'
    | 'prefetch-source-not-serving-then-pending-success'
    | 'source-not-serving'
    | 'generic-404'
  /** One-based aggregate request number to hold until the test releases it. */
  pendingAggregateCall?: number
}

interface DeferredSignal {
  promise: Promise<void>
  resolve: () => void
}

function deferredSignal(): DeferredSignal {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function accountId(subject: LinkedSubject): string {
  return `${encodeURIComponent(subject.platform)}:${encodeURIComponent(subject.traderKey)}`
}

function syntheticLinkedSubject(primary: LinkedSubject): LinkedSubject {
  return {
    // Keep the synthetic account distinct even if the real subject is Bybit.
    platform:
      primary.platform === MOCK_LINKED_PLATFORM
        ? MOCK_FALLBACK_LINKED_PLATFORM
        : MOCK_LINKED_PLATFORM,
    traderKey: MOCK_LINKED_KEY,
  }
}

/** Model an accepted request alias resolving to a distinct canonical serving slug. */
function canonicalLinkedSubject(request: LinkedSubject): LinkedSubject {
  return {
    platform: MOCK_CANONICAL_LINKED_PLATFORM,
    traderKey: request.traderKey,
  }
}

/** Build an exact public contract-v2 response for the requested subject. */
function makeLinkedAccountsFixture(subject: LinkedSubject, accountCount: 2 | 4) {
  const linkedSubject = syntheticLinkedSubject(subject)
  const accounts = [
    {
      id: accountId(subject),
      platform: subject.platform,
      traderKey: subject.traderKey,
      handle: null,
      label: 'Primary fixture account',
      isPrimary: true,
      roi: MOCK_PRIMARY_ROI,
      pnl: null,
      arenaScore: null,
      winRate: 65,
      maxDrawdown: 22,
      rank: null,
    },
    {
      id: accountId(linkedSubject),
      platform: linkedSubject.platform,
      traderKey: linkedSubject.traderKey,
      handle: null,
      label: MOCK_LINKED_LABEL,
      isPrimary: false,
      roi: MOCK_LINKED_ROI,
      pnl: null,
      arenaScore: null,
      winRate: 61,
      maxDrawdown: 18,
      rank: null,
    },
  ]

  if (accountCount === 4) {
    accounts.push(
      {
        id: accountId({ platform: 'okx_futures', traderKey: 'mock-linked-extra-okx' }),
        platform: 'okx_futures',
        traderKey: 'mock-linked-extra-okx',
        handle: null,
        label: 'Synthetic OKX account',
        isPrimary: false,
        roi: 44.4,
        pnl: null,
        arenaScore: null,
        winRate: 57,
        maxDrawdown: 24,
        rank: null,
      },
      {
        id: accountId({ platform: 'bitget_futures', traderKey: 'mock-linked-extra-bitget' }),
        platform: 'bitget_futures',
        traderKey: 'mock-linked-extra-bitget',
        handle: null,
        label: 'Synthetic Bitget account',
        isPrimary: false,
        roi: -12.34,
        pnl: null,
        arenaScore: null,
        winRate: 48,
        maxDrawdown: 31,
        rank: null,
      }
    )
  }

  return {
    success: true,
    data: {
      subject: { ...subject },
      aggregated: {
        combinedPnl: null,
        bestRoi: null,
        weightedScore: null,
      },
      accounts,
      totalAccounts: accounts.length,
    },
  }
}

function makeFirstScreenFixture(request: LinkedSubject) {
  const subject = canonicalLinkedSubject(request)
  const asOf = '2026-07-29T12:00:00.000Z'
  return {
    success: true,
    data: {
      request: { platform: request.platform, handle: request.traderKey },
      subject: { ...subject },
      firstScreen: {
        source: subject.platform,
        exchangeTraderId: subject.traderKey,
        nickname: MOCK_LINKED_NAME,
        avatarMirrorUrl: null,
        avatarOriginUrl: null,
        avatarSrc: null,
        walletAddress: null,
        traderKind: 'human',
        botStrategy: null,
        entries: [
          {
            timeframe: 90,
            rank: MOCK_LINKED_RANK,
            rankingVisibility: 'verified',
            rankingVisibilityReason: null,
            headlineRoi: MOCK_LINKED_ROI,
            headlinePnl: null,
            headlineWinRate: 61,
            extras: { mdd: 18 },
            provenance: { source: subject.platform, asOf },
          },
        ],
      },
      capability: {
        timeframes: { '7': 'native', '30': 'native', '90': 'native' },
        inceptionTf: false,
        metrics: ['roi', 'pnl', 'win_rate', 'mdd', 'total_positions'],
        surfaces: {
          positions: false,
          position_history: false,
          orders: false,
          transfers: false,
          copiers: false,
        },
        copierDepth: 'none',
        currency: 'USDT',
        isOnchain: false,
        derivedBoardNote: false,
        exchangeName: MOCK_LINKED_LABEL,
      },
      is_verified_data: false,
    },
  }
}

function makeFirstScreenNotFound(request: LinkedSubject, sourceNotServing: boolean) {
  return {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: sourceNotServing
        ? 'Source does not publish a serving first screen'
        : 'Trader not found',
      ...(sourceNotServing && {
        details: {
          reason: 'source_not_serving',
          request: { platform: request.platform, handle: request.traderKey },
        },
      }),
      timestamp: '2026-07-29T12:00:00.000Z',
    },
  }
}

function exactAggregateSubject(url: URL): LinkedSubject | null {
  const queryKeys = [...url.searchParams.keys()].sort()
  const contractValues = url.searchParams.getAll('contract')
  const platformValues = url.searchParams.getAll('platform')
  const traderKeyValues = url.searchParams.getAll('trader_key')
  const isExactV2Request =
    url.pathname === '/api/traders/aggregate' &&
    queryKeys.join(',') === 'contract,platform,trader_key' &&
    contractValues.length === 1 &&
    contractValues[0] === '2' &&
    platformValues.length === 1 &&
    platformValues[0].length > 0 &&
    traderKeyValues.length === 1 &&
    traderKeyValues[0].length > 0

  return isExactV2Request ? { platform: platformValues[0], traderKey: traderKeyValues[0] } : null
}

function subjectsMatch(left: LinkedSubject, right: LinkedSubject): boolean {
  return left.platform === right.platform && left.traderKey === right.traderKey
}

/**
 * Mock only exact subject-bound linked-account contracts. Malformed or broader
 * selectors receive a hard 400, so UI assertions cannot pass against the wrong
 * identity or an accidentally widened API call.
 */
async function stubLinkedAccountApis(
  page: Page,
  {
    accountCount = 2,
    firstScreenScenario = 'success',
    pendingAggregateCall,
  }: LinkedApiFixtureOptions = {}
): Promise<LinkedAccountRequests> {
  const firstScreenLiveStarted = deferredSignal()
  const firstScreenLiveRelease = deferredSignal()
  const aggregatePendingStarted = deferredSignal()
  const aggregatePendingRelease = deferredSignal()
  const requests: LinkedAccountRequests = {
    aggregateCalls: [],
    firstScreenCalls: [],
    coreCalls: [],
    legacyCalls: [],
    invalidCalls: [],
    controls: {
      firstScreenLiveRequestStarted: firstScreenLiveStarted.promise,
      releaseFirstScreenLiveRequest: firstScreenLiveRelease.resolve,
      aggregatePendingRequestStarted: aggregatePendingStarted.promise,
      releaseAggregatePendingRequest: aggregatePendingRelease.resolve,
    },
  }

  await page.route(/\/api\/traders\/aggregate(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    const subject = exactAggregateSubject(url)

    if (!subject) {
      requests.invalidCalls.push(url.toString())
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'expected exact contract-v2 subject' }),
      })
      return
    }

    requests.aggregateCalls.push({ url: url.toString(), subject })
    if (requests.aggregateCalls.length === pendingAggregateCall) {
      aggregatePendingStarted.resolve()
      await aggregatePendingRelease.promise
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'private, no-store, max-age=0' },
      body: JSON.stringify(makeLinkedAccountsFixture(subject, accountCount)),
    })
  })

  await page.route(
    new RegExp(`/api/traders/${MOCK_LINKED_KEY}/first-screen(?:\\?|$)`),
    async (route) => {
      const url = new URL(route.request().url())
      const queryKeys = [...url.searchParams.keys()].sort()
      const sourceValues = url.searchParams.getAll('source')
      const requestSubject = {
        platform: sourceValues[0] ?? '',
        traderKey: MOCK_LINKED_KEY,
      }
      const membershipProvesSubject = requests.aggregateCalls.some((call) =>
        subjectsMatch(syntheticLinkedSubject(call.subject), requestSubject)
      )
      const isExact =
        url.pathname === `/api/traders/${MOCK_LINKED_KEY}/first-screen` &&
        queryKeys.join(',') === 'source' &&
        sourceValues.length === 1 &&
        sourceValues[0].length > 0 &&
        membershipProvesSubject

      if (!isExact) {
        requests.invalidCalls.push(url.toString())
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'expected exact linked first-screen' }),
        })
        return
      }

      requests.firstScreenCalls.push({
        url: url.toString(),
        request: requestSubject,
        canonicalSubject: canonicalLinkedSubject(requestSubject),
      })
      const callNumber = requests.firstScreenCalls.length
      const sourceNotServing =
        firstScreenScenario === 'source-not-serving' ||
        (firstScreenScenario === 'prefetch-source-not-serving-then-pending-success' &&
          callNumber === 1)
      if (sourceNotServing || firstScreenScenario === 'generic-404') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          headers: { 'cache-control': 'private, no-store, max-age=0' },
          body: JSON.stringify(
            makeFirstScreenNotFound(requestSubject, firstScreenScenario !== 'generic-404')
          ),
        })
        return
      }

      if (
        firstScreenScenario === 'prefetch-source-not-serving-then-pending-success' &&
        callNumber >= 2
      ) {
        firstScreenLiveStarted.resolve()
        await firstScreenLiveRelease.promise
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'private, no-store, max-age=0' },
        body: JSON.stringify(makeFirstScreenFixture(requestSubject)),
      })
    }
  )

  // The public /core projection is quarantined for every timeframe and the
  // client builds it locally, so the detail page must never request it.
  await page.route(/\/api\/traders\/[^/]+\/core(?:\?|$)/, async (route) => {
    requests.coreCalls.push(route.request().url())
    await route.fulfill({ status: 410, body: 'quarantined /core must not be requested' })
  })

  // This is the legacy detail boundary selected-account fallback may call only
  // after an exact request-bound source_not_serving response has settled.
  await page.route(new RegExp(`/api/traders/${MOCK_LINKED_KEY}(?:\\?|$)`), async (route) => {
    const url = new URL(route.request().url())
    const queryKeys = [...url.searchParams.keys()].sort()
    const sourceValues = url.searchParams.getAll('source')
    const isExact =
      url.pathname === `/api/traders/${MOCK_LINKED_KEY}` &&
      queryKeys.join(',') === 'source' &&
      sourceValues.length === 1 &&
      sourceValues[0].length > 0

    if (!isExact) {
      requests.invalidCalls.push(url.toString())
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'expected exact legacy detail subject' }),
      })
      return
    }

    requests.legacyCalls.push(url.toString())
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify(
        makeFirstScreenNotFound(
          {
            platform: sourceValues[0],
            traderKey: MOCK_LINKED_KEY,
          },
          false
        )
      ),
    })
  })

  return requests
}

/**
 * Top-level ?platform= fixture: the serving authority first proves this route
 * selector is legacy, then the exact legacy detail succeeds. Its second
 * first-screen read is held so the test can inspect the live-revalidation frame.
 */
async function stubTopLevelLegacyOverride(page: Page, routeHandle: string) {
  const revalidationStarted = deferredSignal()
  const revalidationRelease = deferredSignal()
  const requests = {
    firstScreenCalls: [] as string[],
    legacyCalls: [] as string[],
    aggregateCalls: [] as string[],
    revalidationStarted: revalidationStarted.promise,
    releaseRevalidation: revalidationRelease.resolve,
  }

  await page.route(
    new RegExp(`/api/traders/${encodeURIComponent(routeHandle)}/first-screen(?:\\?|$)`),
    async (route) => {
      const url = new URL(route.request().url())
      const sourceValues = url.searchParams.getAll('source')
      const isExact =
        url.pathname === `/api/traders/${encodeURIComponent(routeHandle)}/first-screen` &&
        [...url.searchParams.keys()].join(',') === 'source' &&
        sourceValues.length === 1 &&
        sourceValues[0] === MOCK_TOP_LEVEL_LEGACY_PLATFORM

      if (!isExact) {
        await route.continue()
        return
      }

      requests.firstScreenCalls.push(url.toString())
      if (requests.firstScreenCalls.length === 2) {
        revalidationStarted.resolve()
        await revalidationRelease.promise
      }
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: { 'cache-control': 'private, no-store, max-age=0' },
        body: JSON.stringify(
          makeFirstScreenNotFound(
            { platform: MOCK_TOP_LEVEL_LEGACY_PLATFORM, traderKey: routeHandle },
            true
          )
        ),
      })
    }
  )

  await page.route(
    new RegExp(`/api/traders/${encodeURIComponent(routeHandle)}(?:\\?|$)`),
    async (route) => {
      const url = new URL(route.request().url())
      const sourceValues = url.searchParams.getAll('source')
      const isExact =
        url.pathname === `/api/traders/${encodeURIComponent(routeHandle)}` &&
        [...url.searchParams.keys()].join(',') === 'source' &&
        sourceValues.length === 1 &&
        sourceValues[0] === MOCK_TOP_LEVEL_LEGACY_PLATFORM

      if (!isExact) {
        await route.continue()
        return
      }

      requests.legacyCalls.push(url.toString())
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'private, no-store, max-age=0' },
        body: JSON.stringify({
          success: true,
          data: {
            profile: {
              id: routeHandle,
              handle: MOCK_TOP_LEVEL_LEGACY_NAME,
              display_name: MOCK_TOP_LEVEL_LEGACY_NAME,
              source: MOCK_TOP_LEVEL_LEGACY_PLATFORM,
              avatar_url: null,
              followers: 0,
              isRegistered: false,
            },
            performance: {
              roi_90d: 42.42,
              pnl: 424.2,
              win_rate: 64,
              max_drawdown: 11,
            },
            stats: null,
            portfolio: [],
            positionHistory: [],
            similarTraders: [],
          },
        }),
      })
    }
  )

  await page.route(/\/api\/traders\/aggregate(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    const subject = exactAggregateSubject(url)
    const expectedSubject = {
      platform: MOCK_TOP_LEVEL_LEGACY_PLATFORM,
      traderKey: routeHandle,
    }
    if (!subject || !subjectsMatch(subject, expectedSubject)) {
      await route.continue()
      return
    }

    requests.aggregateCalls.push(url.toString())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'private, no-store, max-age=0' },
      body: JSON.stringify({
        success: true,
        data: {
          subject,
          aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
          accounts: [
            {
              id: accountId(subject),
              platform: subject.platform,
              traderKey: subject.traderKey,
              handle: MOCK_TOP_LEVEL_LEGACY_NAME,
              label: null,
              isPrimary: true,
              roi: 42.42,
              pnl: null,
              arenaScore: null,
              winRate: 64,
              maxDrawdown: 11,
              rank: null,
            },
          ],
          totalAccounts: 1,
        },
      }),
    })
  })

  return requests
}

async function getRequiredTraderHref(page: Page): Promise<string> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await dismissOverlays(page)

  const traderLink = page.locator('#homepage-interactive a[href*="/trader/"]').first()
  await expect(traderLink).toBeVisible({ timeout: 30_000 })

  const href = await traderLink.getAttribute('href')
  expect(href, 'homepage must expose a navigable trader-detail link').toBeTruthy()
  expect(href).toContain('/trader/')
  return href!
}

/** Every hard trader-page navigation must issue exactly one live membership read. */
async function navigateWithOneAggregateRequest(
  page: Page,
  href: string,
  requests: LinkedAccountRequests
): Promise<LinkedSubject> {
  const callCountBeforeNavigation = requests.aggregateCalls.length
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return exactAggregateSubject(url) !== null && response.status() === 200
  })

  await page.goto(href, { waitUntil: 'domcontentloaded' })
  await responsePromise
  await page.waitForLoadState('networkidle')
  await dismissOverlays(page)

  const navigationCalls = requests.aggregateCalls.slice(callCountBeforeNavigation)
  expect(navigationCalls, 'one exact standalone aggregate read per navigation').toHaveLength(1)
  expect(requests.invalidCalls, 'no widened or malformed linked-account request').toHaveLength(0)
  return navigationCalls[0].subject
}

function linkedAccountRadiogroup(page: Page): Locator {
  return page.locator('[role="radiogroup"].linked-tabs-scroll')
}

function syntheticAccountControl(scope: Page | Locator): Locator {
  return scope.getByRole('radio').filter({ hasText: MOCK_LINKED_ROI_TEXT })
}

async function openTraderWithLinkedAccounts(
  page: Page,
  href: string,
  requests: LinkedAccountRequests
): Promise<{ primarySubject: LinkedSubject; radiogroup: Locator }> {
  const primarySubject = await navigateWithOneAggregateRequest(page, href, requests)
  const radiogroup = linkedAccountRadiogroup(page)
  await expect(radiogroup).toBeVisible({ timeout: 15_000 })
  await expect(radiogroup.getByRole('radio')).toHaveCount(3)
  return { primarySubject, radiogroup }
}

function withAccount(href: string, subject: LinkedSubject): string {
  const url = new URL(href, 'http://playwright.local')
  url.searchParams.set('account', `${subject.platform}:${subject.traderKey}`)
  return `${url.pathname}${url.search}${url.hash}`
}

function withPlatform(href: string, platform: string): string {
  const url = new URL(href, 'http://playwright.local')
  url.searchParams.set('platform', platform)
  return `${url.pathname}${url.search}${url.hash}`
}

function traderRouteHandle(href: string): string {
  const url = new URL(href, 'http://playwright.local')
  const encodedHandle = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
  return decodeURIComponent(encodedHandle)
}

function allAccountsControl(page: Page): Locator {
  return linkedAccountRadiogroup(page).getByRole('radio', { name: /^All accounts 2$/ })
}

async function expectAllAccountScope(page: Page) {
  const header = page.locator('.profile-header')
  await expect(header).toBeVisible()
  await expect(page.locator('.performance-card')).toHaveCount(0)
  await expect(header.locator('[title^="Arena Score:"]')).toHaveCount(0)
  await expect(header.locator('[aria-label^="Beats "]')).toHaveCount(0)
  await expect(header).not.toContainText(/Ranked [\d,]+ on /)
  await expect(header.getByRole('button')).toHaveCount(0)
  await expect(page.getByTestId('exchange-links-bar')).toHaveCount(0)
  await expect(page.locator('#tab-posts')).toHaveCount(0)
}

async function expectRequestedAccountShell(
  page: Page,
  priorHeading: string,
  status: 'checking' | 'unavailable' = 'checking'
) {
  const header = page.locator('.profile-header')
  await expect(page.getByRole('heading', { level: 1, name: MOCK_LINKED_KEY })).toBeVisible()
  if (priorHeading !== MOCK_LINKED_KEY) {
    await expect(page.getByRole('heading', { level: 1, name: priorHeading })).toHaveCount(0)
  }
  await expect(
    page.getByText(
      status === 'checking'
        ? 'Verifying this account’s detail…'
        : 'This account’s verified detail is temporarily unavailable.',
      { exact: true }
    )
  ).toBeVisible()
  await expect(page.locator('.performance-card')).toHaveCount(0)
  await expect(header.getByRole('button')).toHaveCount(0)
  await expect(page.getByTestId('exchange-links-bar')).toHaveCount(0)
}

async function expectSyntheticServingView(
  page: Page,
  requests: LinkedAccountRequests,
  subject: LinkedSubject
) {
  const account = `${subject.platform}:${subject.traderKey}`
  const canonicalSubject = canonicalLinkedSubject(subject)
  await expect.poll(() => new URL(page.url()).searchParams.get('account')).toBe(account)
  await expect(page.getByRole('heading', { level: 1, name: MOCK_LINKED_NAME })).toBeVisible()

  await expect
    .poll(
      () => requests.firstScreenCalls.filter((call) => subjectsMatch(call.request, subject)).length
    )
    .toBeGreaterThan(0)
  // History is quarantined: one verification notice carrying only the sealed
  // public rank/ROI of the exact linked subject, never a performance card.
  const notice = page.getByTestId('history-verification-notice').first()
  await expect(notice).toBeVisible()
  await expect(notice.getByText(`#${MOCK_LINKED_RANK}`, { exact: true })).toBeVisible()
  await expect(notice.getByText(MOCK_LINKED_ROI_TEXT, { exact: true })).toBeVisible()
  await expect(page.locator('.performance-card')).toHaveCount(0)

  for (const call of requests.firstScreenCalls) {
    expect(call.request).toEqual(subject)
    expect(call.canonicalSubject).toEqual(canonicalSubject)
    const url = new URL(call.url)
    expect(url.pathname).toContain(`/${MOCK_LINKED_KEY}/`)
    expect(url.searchParams.get('source')).toBe(subject.platform)
  }
  expect(requests.coreCalls, 'quarantined /core must not be requested').toHaveLength(0)
  expect(requests.invalidCalls).toHaveLength(0)
}

test.describe('交易员详情页 - 账号切换 (account switching)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('language', 'en'))
  })

  test('renders exact linked DTO values and keeps All account-scoped metrics hidden', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page)
    const href = await getRequiredTraderHref(page)
    const { radiogroup } = await openTraderWithLinkedAccounts(page, href, requests)

    await expect(allAccountsControl(page)).toHaveAttribute('aria-checked', 'true')
    await expect(radiogroup.getByRole('radio').filter({ hasText: '+180.5%' })).toHaveCount(1)
    await expect(syntheticAccountControl(radiogroup)).toHaveCount(1)
    await expect(syntheticAccountControl(radiogroup)).toContainText(MOCK_LINKED_ROI_TEXT)
    await expectAllAccountScope(page)
  })

  test('direct synthetic account URL rekeys first-screen to its exact identity without /core', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page)
    const href = await getRequiredTraderHref(page)
    const { primarySubject } = await openTraderWithLinkedAccounts(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)

    await navigateWithOneAggregateRequest(page, withAccount(href, linkedSubject), requests)

    const selectedAccount = syntheticAccountControl(linkedAccountRadiogroup(page))
    await expect(selectedAccount).toHaveAttribute('aria-checked', 'true')
    await expectSyntheticServingView(page, requests, linkedSubject)
  })

  test('top-level legacy override is withdrawn while serving authority revalidates', async ({
    page,
  }) => {
    const href = await getRequiredTraderHref(page)
    const routeHandle = traderRouteHandle(href)
    expect(routeHandle).not.toBe('')
    const requests = await stubTopLevelLegacyOverride(page, routeHandle)

    await page.goto(withPlatform(href, MOCK_TOP_LEVEL_LEGACY_PLATFORM), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForLoadState('networkidle')
    await dismissOverlays(page)

    await expect(
      page.getByRole('heading', { level: 1, name: MOCK_TOP_LEVEL_LEGACY_NAME })
    ).toBeVisible()
    await expect(
      page.locator('.performance-card').getByText(MOCK_TOP_LEVEL_LEGACY_ROI_TEXT, { exact: true })
    ).toBeVisible()
    expect(requests.firstScreenCalls).toHaveLength(1)
    expect(requests.legacyCalls).toHaveLength(1)
    expect(requests.aggregateCalls).toHaveLength(1)

    const authorityResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === `/api/traders/${encodeURIComponent(routeHandle)}/first-screen` &&
        url.searchParams.get('source') === MOCK_TOP_LEVEL_LEGACY_PLATFORM &&
        response.status() === 404
      )
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await requests.revalidationStarted

    expect(requests.firstScreenCalls).toHaveLength(2)
    await expect(
      page.getByRole('heading', { level: 1, name: MOCK_TOP_LEVEL_LEGACY_NAME })
    ).toHaveCount(0)
    await expect(page.getByText('Verifying this account’s detail…', { exact: true })).toBeVisible()
    await expect(page.locator('.performance-card')).toHaveCount(0)
    await expect(page.locator('.profile-header').getByRole('button')).toHaveCount(0)
    await expect(page.getByTestId('exchange-links-bar')).toHaveCount(0)
    await expect(page.locator('#tab-posts')).toHaveCount(0)

    requests.releaseRevalidation()
    await authorityResponse
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByRole('heading', { level: 1, name: MOCK_TOP_LEVEL_LEGACY_NAME })
    ).toBeVisible()
    await expect(
      page.locator('.performance-card').getByText(MOCK_TOP_LEVEL_LEGACY_ROI_TEXT, { exact: true })
    ).toBeVisible()
  })

  test('cached prefetch 404 cannot authorize legacy while live selection proof is pending', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page, {
      firstScreenScenario: 'prefetch-source-not-serving-then-pending-success',
    })
    const href = await getRequiredTraderHref(page)
    const { primarySubject, radiogroup } = await openTraderWithLinkedAccounts(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)
    const priorHeading = (await page.locator('.profile-header h1').textContent())?.trim() ?? ''
    expect(priorHeading).not.toBe('')

    const prefetched404 = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === `/api/traders/${MOCK_LINKED_KEY}/first-screen` &&
        url.searchParams.get('source') === linkedSubject.platform &&
        response.status() === 404
      )
    })
    const selectedAccount = syntheticAccountControl(radiogroup)
    await selectedAccount.hover()
    const prefetchResponse = await prefetched404
    const prefetchError = await prefetchResponse.json()
    expect(prefetchError).toMatchObject({
      success: false,
      error: {
        details: {
          reason: 'source_not_serving',
          request: { platform: linkedSubject.platform, handle: linkedSubject.traderKey },
        },
      },
    })
    expect(requests.firstScreenCalls).toHaveLength(1)

    await selectedAccount.press('Enter')
    await requests.controls.firstScreenLiveRequestStarted

    await expectRequestedAccountShell(page, priorHeading)
    expect(requests.legacyCalls, 'cached 404 must not authorize legacy fallback').toHaveLength(0)

    const liveResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === `/api/traders/${MOCK_LINKED_KEY}/first-screen` &&
        url.searchParams.get('source') === linkedSubject.platform &&
        response.status() === 200
      )
    })
    requests.controls.releaseFirstScreenLiveRequest()
    await liveResponse
    await expectSyntheticServingView(page, requests, linkedSubject)
    expect(requests.legacyCalls).toHaveLength(0)
  })

  test('explicit account navigation renders the requested shell while membership revalidates', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page, { pendingAggregateCall: 2 })
    const href = await getRequiredTraderHref(page)
    const { primarySubject } = await openTraderWithLinkedAccounts(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)
    const priorHeading = (await page.locator('.profile-header h1').textContent())?.trim() ?? ''
    expect(priorHeading).not.toBe('')

    const aggregateResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return exactAggregateSubject(url) !== null && response.status() === 200
    })
    await page.goto(withAccount(href, linkedSubject), { waitUntil: 'domcontentloaded' })
    await dismissOverlays(page)
    await requests.controls.aggregatePendingRequestStarted

    await expectRequestedAccountShell(page, priorHeading)
    expect(requests.firstScreenCalls).toHaveLength(0)
    expect(requests.legacyCalls).toHaveLength(0)

    requests.controls.releaseAggregatePendingRequest()
    await aggregateResponse
    await page.waitForLoadState('networkidle')
    await expectSyntheticServingView(page, requests, linkedSubject)
    expect(requests.aggregateCalls).toHaveLength(2)
  })

  test('generic serving 404 stays closed and never requests legacy detail', async ({ page }) => {
    const requests = await stubLinkedAccountApis(page, { firstScreenScenario: 'generic-404' })
    const href = await getRequiredTraderHref(page)
    const { primarySubject, radiogroup } = await openTraderWithLinkedAccounts(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)
    const priorHeading = (await page.locator('.profile-header h1').textContent())?.trim() ?? ''
    expect(priorHeading).not.toBe('')

    const generic404 = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === `/api/traders/${MOCK_LINKED_KEY}/first-screen` &&
        url.searchParams.get('source') === linkedSubject.platform &&
        response.status() === 404
      )
    })
    await syntheticAccountControl(radiogroup).press('Enter')
    const genericResponse = await generic404
    const genericError = await genericResponse.json()
    expect(genericError).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Trader not found' },
    })
    expect(genericError.error.details).toBeUndefined()

    await expectRequestedAccountShell(page, priorHeading, 'unavailable')
    expect(requests.legacyCalls, 'generic 404 must not authorize legacy fallback').toHaveLength(0)
  })

  test('exact source_not_serving details authorize the request-bound legacy fallback', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page, {
      firstScreenScenario: 'source-not-serving',
    })
    const href = await getRequiredTraderHref(page)
    const { primarySubject, radiogroup } = await openTraderWithLinkedAccounts(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)

    const notServing404 = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === `/api/traders/${MOCK_LINKED_KEY}/first-screen` &&
        url.searchParams.get('source') === linkedSubject.platform &&
        response.status() === 404
      )
    })
    await syntheticAccountControl(radiogroup).press('Enter')
    const response = await notServing404
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        details: {
          reason: 'source_not_serving',
          request: { platform: linkedSubject.platform, handle: linkedSubject.traderKey },
        },
      },
    })

    await expect.poll(() => requests.legacyCalls.length).toBe(1)
    const legacyUrl = new URL(requests.legacyCalls[0])
    expect(legacyUrl.pathname).toBe(`/api/traders/${MOCK_LINKED_KEY}`)
    expect([...legacyUrl.searchParams.entries()]).toEqual([['source', linkedSubject.platform]])
  })

  test('never bundles aggregate and calls the standalone endpoint with one exact subject', async ({
    page,
  }) => {
    const bundledAggregateCalls: string[] = []
    const requests = await stubLinkedAccountApis(page)

    page.on('request', (request) => {
      const url = new URL(request.url())
      const isTraderDetail =
        /^\/api\/traders\/[^/]+$/.test(url.pathname) && url.pathname !== '/api/traders/aggregate'
      const includesAggregate =
        url.searchParams
          .get('include')
          ?.split(',')
          .map((value) => value.trim())
          .includes('aggregate') ?? false

      if (isTraderDetail && includesAggregate) bundledAggregateCalls.push(url.toString())
    })

    const href = await getRequiredTraderHref(page)
    await openTraderWithLinkedAccounts(page, href, requests)

    expect(bundledAggregateCalls).toHaveLength(0)
    expect(requests.aggregateCalls).toHaveLength(1)
    expect(requests.invalidCalls).toHaveLength(0)
    const call = requests.aggregateCalls[0]
    const url = new URL(call.url)
    expect(url.pathname).toBe('/api/traders/aggregate')
    expect([...url.searchParams.entries()]).toEqual([
      ['contract', '2'],
      ['platform', call.subject.platform],
      ['trader_key', call.subject.traderKey],
    ])
  })

  test('synthetic account interaction succeeds and All clears URL plus scoped content', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page)
    const href = await getRequiredTraderHref(page)
    const { primarySubject, radiogroup } = await openTraderWithLinkedAccounts(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)
    const selectedAccount = syntheticAccountControl(radiogroup)

    await selectedAccount.press('Enter')
    await expect(selectedAccount).toHaveAttribute('aria-checked', 'true')
    await expectSyntheticServingView(page, requests, linkedSubject)

    const allAccounts = allAccountsControl(page)
    await allAccounts.click()

    await expect.poll(() => new URL(page.url()).searchParams.get('account')).toBeNull()
    await expect(allAccounts).toHaveAttribute('aria-checked', 'true')
    await expectAllAccountScope(page)
    expect(requests.aggregateCalls).toHaveLength(1)
  })

  test('confirmed All remains aggregate-scoped while live membership revalidates', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page, { pendingAggregateCall: 2 })
    const href = await getRequiredTraderHref(page)
    await openTraderWithLinkedAccounts(page, href, requests)
    await expectAllAccountScope(page)

    const aggregateResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return exactAggregateSubject(url) !== null && response.status() === 200
    })
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await requests.controls.aggregatePendingRequestStarted

    expect(requests.aggregateCalls).toHaveLength(2)
    await expect(page.getByTestId('linked-account-selector')).toHaveCount(0)
    await expectAllAccountScope(page)

    requests.controls.releaseAggregatePendingRequest()
    await aggregateResponse
    await page.waitForLoadState('networkidle')
    await expect(allAccountsControl(page)).toHaveAttribute('aria-checked', 'true')
    await expectAllAccountScope(page)
  })

  test('four-account selector supports mobile touch dropdown and desktop radios', async ({
    page,
  }) => {
    const requests = await stubLinkedAccountApis(page, { accountCount: 4 })
    const href = await getRequiredTraderHref(page)
    const primarySubject = await navigateWithOneAggregateRequest(page, href, requests)
    const linkedSubject = syntheticLinkedSubject(primarySubject)
    const isMobileDropdown = (page.viewportSize()?.width ?? 1280) <= 768

    if (isMobileDropdown) {
      await expect(linkedAccountRadiogroup(page)).toHaveCount(0)
      const trigger = page.getByRole('button', { name: /^All accounts 4$/ })
      await expect(trigger).toBeVisible()
      await trigger.tap()

      const option = page.getByRole('menuitemradio').filter({ hasText: MOCK_LINKED_ROI_TEXT })
      await expect(option).toHaveCount(1)
      await option.tap()
    } else {
      const radiogroup = linkedAccountRadiogroup(page)
      await expect(radiogroup).toBeVisible()
      await expect(radiogroup.getByRole('radio')).toHaveCount(5)
      const account = syntheticAccountControl(radiogroup)
      await expect(account).toHaveCount(1)
      await account.press('Enter')
    }

    await expectSyntheticServingView(page, requests, linkedSubject)
    expect(requests.aggregateCalls).toHaveLength(1)
  })
})
