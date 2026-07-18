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
        return okJson({ subscription: { tier: 'pro' } })
      }
      if (url.startsWith('/api/following')) {
        return okJson({ items: [] })
      }
      if (url.startsWith('/api/search')) {
        searchAttempts += 1
        if (searchAttempts === 1) return { ok: false, status: 503, json: async () => ({}) }
        return okJson({
          data: {
            results: {
              traders: [
                {
                  id: 'binance:alice',
                  type: 'trader',
                  title: '@alice',
                  subtitle: 'Binance',
                },
              ],
            },
          },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    const input = await screen.findByRole('searchbox', { name: 'Search traders' })
    fireEvent.change(input, { target: { value: 'alice' } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed, please try again')
    expect(screen.queryByText('No search results')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('@alice')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(searchAttempts).toBe(2)
  })

  it('shows a retryable followed-trader error instead of an empty state', async () => {
    let followingAttempts = 0
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson({ subscription: { tier: 'pro' } })
      }
      if (url.startsWith('/api/following')) {
        followingAttempts += 1
        if (followingAttempts === 1) {
          return { ok: false, status: 503, json: async () => ({}) }
        }
        return okJson({
          items: [
            {
              id: 'alice',
              handle: 'Alice',
              type: 'trader',
              source: 'binance',
              roi: 12,
            },
          ],
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    render(<ComparePageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.queryByText('No followed traders')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(followingAttempts).toBe(2))
    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports unresolved URL accounts and replaces the URL with only loaded identities', async () => {
    mockSearchParams.set('ids', 'alice,ghost')
    mockSearchParams.set('platforms', 'binance,bybit')
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/subscription') {
        return okJson({ subscription: { tier: 'pro' } })
      }
      if (url.startsWith('/api/following')) {
        return okJson({ items: [] })
      }
      if (url.startsWith('/api/compare')) {
        return okJson({
          data: {
            traders: [
              {
                id: 'alice',
                source: 'binance',
                handle: 'Alice',
                roi: 12,
              },
            ],
            missingAccounts: [{ id: 'ghost', source: 'bybit' }],
          },
        })
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
})
