import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockPush = jest.fn()
const mockReplace = jest.fn()
const mockShowToast = jest.fn()
const mockGetUser = jest.fn()
const mockSearchParams = new URLSearchParams()

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
  useAuthSession: () => ({
    accessToken: 'access-token',
    authChecked: true,
    email: 'viewer@example.com',
    userId: 'viewer-1',
  }),
}))

jest.mock('@/lib/hooks/useAchievements', () => ({
  useAchievements: () => ({ tryUnlock: jest.fn() }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          compareAddFromRankings: 'Add from rankings',
          compareAddTrader: 'Add trader',
          compareDesc: 'Compare performance',
          compareFromFollowing: 'From following',
          compareNoFollowed: 'No followed traders',
          compareSearchNoResults: 'No search results',
          compareSearchPlaceholder: 'Search traders',
          compareSearching: 'Searching',
          compareSomeUnavailable:
            'Some requested traders are unavailable and were removed from this comparison.',
          compareTraders: 'Compare traders',
          errorOccurred: 'Something went wrong, please try again',
          loadFollowingFailed: 'Failed to load following',
          loading: 'Loading',
          retry: 'Retry',
          searchFailed: 'Search failed, please try again',
          somethingWentWrong: 'Something went wrong',
        }) as Record<string, string>
      )[key] || key,
  }),
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

import ComparePageClient from '../ComparePageClient'

const originalFetch = global.fetch

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

function followingBody(items: Array<Record<string, unknown>> = []) {
  const traderCount = items.filter((item) => item.type === 'trader').length
  const userCount = items.filter((item) => item.type === 'user').length
  return { items, count: items.length, traderCount, userCount }
}

function compareBody(
  requestedAccounts: Array<{ id: string; source: string }>,
  traders: Array<Record<string, unknown>>,
  missingAccounts: Array<{ id: string; source: string }> = []
) {
  return {
    success: true,
    data: {
      traders,
      missingAccounts,
      requestedIds: requestedAccounts.map((account) => account.id),
      requestedPlatforms: requestedAccounts.map((account) => account.source),
      requestedAccounts,
      foundCount: traders.length,
    },
    meta: { timestamp: '2026-08-04T00:00:00.000Z' },
  }
}

function searchBody(query: string, traders: Array<Record<string, unknown>>) {
  return {
    success: true,
    data: {
      query,
      results: { traders, posts: [], users: [], groups: [] },
      total: traders.length,
    },
    meta: { timestamp: '2026-08-04T00:00:00.000Z' },
  }
}

describe('ComparePageClient discovery failures', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams.delete('ids')
    mockSearchParams.delete('platforms')
    mockGetUser.mockResolvedValue({ data: { user: { id: 'viewer-1' } } })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('distinguishes a failed trader search from no results and retries it', async () => {
    let searchAttempts = 0
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson(subscriptionBody())
      }
      if (url.startsWith('/api/following')) {
        return okJson(followingBody())
      }
      if (url.startsWith('/api/search')) {
        searchAttempts += 1
        if (searchAttempts === 1) return { ok: false, status: 503, json: async () => ({}) }
        return okJson(
          searchBody('alice', [
            {
              id: 'binance:alice',
              type: 'trader',
              title: '@alice',
              subtitle: 'Binance',
              href: '/trader/alice?platform=binance',
            },
          ])
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    const input = await screen.findByRole('searchbox', { name: 'Search traders' })
    fireEvent.change(input, { target: { value: 'alice' } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed, please try again')
    expect(screen.queryByText('No search results')).not.toBeInTheDocument()
    expect(input).toHaveStyle({ minHeight: '44px' })

    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).toHaveStyle({ minHeight: '44px' })
    fireEvent.click(retry)

    expect(await screen.findByText('@alice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /@alice/i })).toHaveStyle({ minHeight: '44px' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(searchAttempts).toBe(2)
  })

  it('shows a retryable followed-trader error instead of an empty state', async () => {
    let followingAttempts = 0
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson(subscriptionBody())
      }
      if (url.startsWith('/api/following')) {
        followingAttempts += 1
        if (followingAttempts === 1) {
          return { ok: false, status: 503, json: async () => ({}) }
        }
        return okJson(
          followingBody([
            {
              id: 'alice',
              identity_key: 'trader:source:binance:alice',
              handle: 'Alice',
              type: 'trader',
              source: 'binance',
              platform: 'binance',
              roi: 12,
            },
          ])
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.queryByText('No followed traders')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(followingAttempts).toBe(2))
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alice/i })).toHaveStyle({ minHeight: '44px' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('treats malformed following counts as an error rather than a genuine empty list', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') return okJson(subscriptionBody())
      if (url.startsWith('/api/following')) {
        return okJson({ items: [], count: 1, traderCount: 0, userCount: 0 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.queryByText('No followed traders')).not.toBeInTheDocument()
  })

  it('rejects a compare success envelope bound to different requested accounts', async () => {
    mockSearchParams.set('ids', 'alice,bob')
    mockSearchParams.set('platforms', 'binance,bybit')
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') return okJson(subscriptionBody())
      if (url.startsWith('/api/following')) return okJson(followingBody())
      if (url.startsWith('/api/compare')) {
        return okJson(
          compareBody(
            [
              { id: 'alice', source: 'binance' },
              { id: 'mallory', source: 'bybit' },
            ],
            [
              { id: 'alice', source: 'binance', handle: 'Alice', roi: 12 },
              { id: 'mallory', source: 'bybit', handle: 'Mallory', roi: 8 },
            ]
          )
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong, please try again'
    )
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('reports unresolved URL accounts and replaces the URL with only loaded identities', async () => {
    mockSearchParams.set('ids', 'alice,ghost')
    mockSearchParams.set('platforms', 'binance,bybit')
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson(subscriptionBody())
      }
      if (url.startsWith('/api/following')) {
        return okJson(followingBody())
      }
      if (url.startsWith('/api/compare')) {
        return okJson(
          compareBody(
            [
              { id: 'alice', source: 'binance' },
              { id: 'ghost', source: 'bybit' },
            ],
            [
              {
                id: 'alice',
                source: 'binance',
                handle: 'Alice',
                roi: 12,
              },
            ],
            [{ id: 'ghost', source: 'bybit' }]
          )
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    expect(await screen.findByText(/Some requested traders are unavailable/)).toBeInTheDocument()
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/compare?ids=alice&platforms=binance', {
        scroll: false,
      })
    )
  })

  it('shows the compare API failure and retries the same source-qualified accounts', async () => {
    mockSearchParams.set('ids', 'shared,shared')
    mockSearchParams.set('platforms', 'bybit,binance_futures')
    let compareAttempts = 0
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson(subscriptionBody())
      }
      if (url.startsWith('/api/following')) {
        return okJson(followingBody())
      }
      if (url.startsWith('/api/compare')) {
        compareAttempts += 1
        if (compareAttempts === 1) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: 'Comparison service is temporarily unavailable' }),
          }
        }
        return okJson(
          compareBody(
            [
              { id: 'shared', source: 'bybit' },
              { id: 'shared', source: 'binance_futures' },
            ],
            [
              { id: 'shared', source: 'bybit', handle: 'Bybit trader', roi: 12 },
              {
                id: 'shared',
                source: 'binance_futures',
                handle: 'Binance trader',
                roi: 8,
              },
            ]
          )
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong, please try again'
    )
    expect(compareAttempts).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(compareAttempts).toBe(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/compare?ids=shared%2Cshared&platforms=bybit%2Cbinance_futures&include_equity=1',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        headers: { Authorization: 'Bearer access-token' },
        signal: expect.any(AbortSignal),
      })
    )
  })
})
