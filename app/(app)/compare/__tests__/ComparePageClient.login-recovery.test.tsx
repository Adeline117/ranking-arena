import { render, waitFor } from '@testing-library/react'

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

function installSuccessfulFetch() {
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
          traders: accounts.map((account) => ({
            ...account,
            handle: account.source,
            roi: 10,
          })),
          missingAccounts: [],
        },
      })
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
        { headers: { Authorization: 'Bearer access-token' } }
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
        return okJson({ subscription: { tier: 'pro' } })
      }
      if (url.startsWith('/api/following')) {
        return okJson({ items: [] })
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
})
