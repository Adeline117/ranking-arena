import { render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockReplace = jest.fn()
const mockGetUser = jest.fn()
let mockAuth = {
  accessToken: null as string | null,
  authChecked: true,
  userId: null as string | null,
}
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function MockDynamicComponent() {
      return null
    },
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/hooks/useAchievements', () => ({
  useAchievements: () => ({ tryUnlock: jest.fn() }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}))

jest.mock('@/lib/premium/hooks', () => ({
  BETA_PRO_FEATURES_FREE: true,
}))

jest.mock('@/app/components/common/ExportButton', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/ProGate', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/LoadingSkeleton', () => ({
  __esModule: true,
  default: () => <div>Loading compare</div>,
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))

import { compareAccountsTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'
import ComparePageClient from '../ComparePageClient'

const originalFetch = global.fetch
const accounts = [
  { id: 'shared', source: 'bybit' },
  { id: 'shared', source: 'binance_futures' },
]
const comparePath = '/compare?ids=shared%2Cshared&platforms=bybit%2Cbinance_futures'

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

function subscriptionBody() {
  return {
    subscription: {
      userId: 'viewer-1',
      tier: 'pro',
      status: 'active',
      startDate: '2026-08-01T00:00:00.000Z',
      endDate: null,
      trialEndDate: null,
      autoRenew: true,
      usage: {
        apiCallsToday: 0,
        comparisonReportsThisMonth: 0,
        exportsThisMonth: 0,
        currentFollows: 0,
        currentCustomRankings: 0,
      },
    },
  }
}

function followingBody() {
  return { items: [], count: 0, traderCount: 0, userCount: 0 }
}

function compareBody() {
  const traders = accounts.map((account) => ({
    ...account,
    handle: account.source,
    roi: 10,
  }))
  return {
    success: true,
    data: {
      traders,
      missingAccounts: [],
      requestedIds: accounts.map((account) => account.id),
      requestedPlatforms: accounts.map((account) => account.source),
      requestedAccounts: accounts,
      foundCount: traders.length,
    },
    meta: { timestamp: '2026-08-04T00:00:00.000Z' },
  }
}

function installSuccessfulFetch() {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/subscription') {
      return okJson(subscriptionBody())
    }
    if (url.startsWith('/api/following')) {
      return okJson(followingBody())
    }
    if (url.startsWith('/api/compare')) {
      return okJson(compareBody())
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

describe('ComparePageClient login recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', comparePath)
    mockSearchParams = new URLSearchParams(window.location.search)
    mockAuth = { accessToken: null, authChecked: true, userId: null }
    mockGetUser.mockResolvedValue({ data: { user: { id: 'viewer-1' } } })
    installSuccessfulFetch()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('keeps ordered trader ids and platforms in the login return URL', async () => {
    render(<ComparePageClient />)

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1))
    const loginUrl = new URL(mockPush.mock.calls[0][0], 'https://arena.invalid')
    expect(loginUrl.pathname).toBe('/login')
    expect(loginUrl.searchParams.get('returnUrl')).toBe(
      `${comparePath}&resumeAction=compare-traders`
    )
  })

  it('restores an exact same-tab comparison after login', async () => {
    const loginUrl = queueProfileActionLogin({
      action: 'compare-traders',
      target: compareAccountsTarget(accounts),
      fallbackPath: comparePath,
      now: Date.now(),
    })
    const returnPath = new URL(loginUrl, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)
    mockSearchParams = new URLSearchParams(window.location.search)
    mockAuth = { accessToken: 'access-token', authChecked: true, userId: 'viewer-1' }

    render(<ComparePageClient />)

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/compare?ids=shared%2Cshared&platforms=bybit%2Cbinance_futures&include_equity=1',
        expect.objectContaining({
          cache: 'no-store',
          credentials: 'include',
          headers: { Authorization: 'Bearer access-token' },
          signal: expect.any(AbortSignal),
        })
      )
    )
    expect(`${window.location.pathname}${window.location.search}`).toBe(comparePath)
    expect(window.sessionStorage).toHaveLength(0)
  })

  it('does not restore an expired-session comparison under another account', async () => {
    const loginUrl = queueProfileActionLogin({
      action: 'compare-traders',
      target: compareAccountsTarget(accounts),
      fallbackPath: comparePath,
      initiatingUserId: 'viewer-a',
      now: Date.now(),
    })
    const returnPath = new URL(loginUrl, 'https://arena.invalid').searchParams.get('returnUrl')!
    window.history.replaceState({}, '', returnPath)
    mockSearchParams = new URLSearchParams(window.location.search)
    mockAuth = { accessToken: 'access-token', authChecked: true, userId: 'viewer-b' }

    render(<ComparePageClient />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/compare', { scroll: false }))
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) =>
        String(input).startsWith('/api/compare')
      )
    ).toBe(false)
    expect(window.sessionStorage).toHaveLength(0)
  })

  it('does not trust a crafted resume marker without same-tab proof', async () => {
    window.history.replaceState({}, '', `${comparePath}&resumeAction=compare-traders`)
    mockSearchParams = new URLSearchParams(window.location.search)
    mockAuth = { accessToken: 'access-token', authChecked: true, userId: 'viewer-1' }

    render(<ComparePageClient />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/compare', { scroll: false }))
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) =>
        String(input).startsWith('/api/compare')
      )
    ).toBe(false)
  })

  it('preserves the exact comparison when an authenticated API session expires', async () => {
    mockAuth = { accessToken: 'expired-token', authChecked: true, userId: 'viewer-1' }
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson(subscriptionBody())
      }
      if (url.startsWith('/api/following')) {
        return okJson(followingBody())
      }
      if (url.startsWith('/api/compare')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Session expired' }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1))
    const loginUrl = new URL(mockPush.mock.calls[0][0], 'https://arena.invalid')
    expect(loginUrl.searchParams.get('returnUrl')).toBe(
      `${comparePath}&resumeAction=compare-traders`
    )
    expect(window.sessionStorage).toHaveLength(1)
  })

  it.each(['subscription', 'following'] as const)(
    'preserves the exact comparison when the %s lane returns 401',
    async (expiredLane) => {
      mockAuth = { accessToken: 'expired-token', authChecked: true, userId: 'viewer-1' }
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/subscription') {
          if (expiredLane === 'subscription') {
            return { ok: false, status: 401, json: async () => ({ error: 'expired' }) }
          }
          return okJson(subscriptionBody())
        }
        if (url.startsWith('/api/following')) {
          if (expiredLane === 'following') {
            return { ok: false, status: 401, json: async () => ({ error: 'expired' }) }
          }
          return okJson(followingBody())
        }
        if (url.startsWith('/api/compare')) return okJson(compareBody())
        throw new Error(`Unexpected fetch: ${url}`)
      }) as unknown as typeof fetch

      render(<ComparePageClient />)

      await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1))
      const loginUrl = new URL(mockPush.mock.calls[0][0], 'https://arena.invalid')
      expect(loginUrl.searchParams.get('returnUrl')).toBe(
        `${comparePath}&resumeAction=compare-traders`
      )
      expect(window.sessionStorage).toHaveLength(1)
    }
  )

  it('does not retain another viewer account comparison while the new scope is pending', async () => {
    mockAuth = { accessToken: 'viewer-1-token', authChecked: true, userId: 'viewer-1' }
    const view = render(<ComparePageClient />)
    await screen.findByText(/2\/10/)

    mockAuth = { accessToken: 'viewer-2-token', authChecked: true, userId: 'viewer-2' }
    global.fetch = jest.fn(() => new Promise(() => undefined)) as unknown as typeof fetch
    view.rerender(<ComparePageClient />)

    expect(await screen.findByText('Loading compare')).toBeInTheDocument()
    expect(screen.queryByText(/2\/10/)).not.toBeInTheDocument()
    view.unmount()
  })

  it('retains same-viewer last-good comparison but labels a failed refresh', async () => {
    mockAuth = { accessToken: 'viewer-1-token', authChecked: true, userId: 'viewer-1' }
    const view = render(<ComparePageClient />)
    await screen.findByText(/2\/10/)

    mockAuth = { accessToken: 'refreshed-token', authChecked: true, userId: 'viewer-1' }
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') return okJson(subscriptionBody())
      if (url.startsWith('/api/following')) return okJson(followingBody())
      if (url.startsWith('/api/compare')) {
        return { ok: false, status: 503, json: async () => ({ error: 'offline' }) }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch
    view.rerender(<ComparePageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent('errorOccurred')
    expect(screen.getByText(/2\/10/)).toBeInTheDocument()
  })
})
