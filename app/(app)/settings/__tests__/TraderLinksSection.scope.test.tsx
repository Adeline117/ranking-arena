import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockShowConfirm = jest.fn()
const mockShowToast = jest.fn()
const mockPush = jest.fn()
const mockRefresh = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Dialog', () => ({
  useDialog: () => ({ showConfirm: mockShowConfirm }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      React.createElement('div', props, children),
    Text: ({
      children,
      color: _color,
      size: _size,
      weight: _weight,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & {
      color?: string
      size?: string
      weight?: string
    }) => React.createElement('span', props, children),
    Button: ({
      children,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) =>
      React.createElement('button', props, children),
  }
})

jest.mock('@/app/components/ui/ExchangeLogo', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/EmptyState', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: ({
      action,
      title,
    }: {
      action?: { label: string; onClick: () => void }
      title: string
    }) =>
      React.createElement(
        'div',
        null,
        title,
        action && React.createElement('button', { onClick: action.onClick }, action.label)
      ),
  }
})

jest.mock('@/lib/utils/format', () => ({ NULL_DISPLAY: '-' }))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

import { TraderLinksSection } from '../components/TraderLinksSection'

type FetchResult = {
  data: unknown
  ok: boolean
  stale?: boolean
  status: number
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    user: { id: userId, email: `${userId}@example.com`, identities: [] },
    userId,
    email: `${userId}@example.com`,
    accessToken: jwt(userId),
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

function linkedTrader(userId: string, label: string, isPrimary = true) {
  return {
    id: `${userId === 'user-a' ? 'aaaaaaaa' : 'bbbbbbbb'}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    user_id: userId,
    trader_id: `${userId}-trader`,
    source: 'binance_futures',
    market_type: 'futures',
    label,
    is_primary: isPrimary,
    display_order: 0,
    verified_at: '2026-07-15T00:00:00.000Z',
    verification_method: 'api_key',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    stats: null,
  }
}

function listResult(rows: unknown[]): FetchResult {
  return { ok: true, status: 200, data: { data: { linked_traders: rows } } }
}

function switchToUserB(rerender: () => void): number {
  const transition = beginViewerTransition('user-b')
  const scopeB = commitViewerTransition(transition, 'user-b')!
  mockAuth = authFor('user-b', scopeB.sessionGeneration)
  rerender()
  return scopeB.sessionGeneration
}

describe('TraderLinksSection viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scopeA = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scopeA.sessionGeneration)
    mockShowConfirm.mockResolvedValue(true)
  })

  it('hides A synchronously and blocks detached A controls while B loads', async () => {
    const listB = deferred<FetchResult>()
    mockAuthedFetch.mockImplementation(
      (url: string, method: string, accessToken: string | null) => {
        if (url === '/api/traders/linked' && method === 'GET') {
          if (accessToken === jwt('user-a'))
            return Promise.resolve(listResult([linkedTrader('user-a', 'Alpha')]))
          if (accessToken === jwt('user-b')) return listB.promise
        }
        return Promise.resolve({ ok: false, status: 500, data: {} })
      }
    )

    const view = render(<TraderLinksSection userId="user-a" />)
    await screen.findByText('Alpha')
    const detachedUnlink = screen.getByRole('button', { name: 'unlinkAccount' })

    let generationB = 0
    act(() => {
      generationB = switchToUserB(() => view.rerender(<TraderLinksSection userId="user-b" />))
    })

    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('loadingText')).toBeInTheDocument()
    fireEvent.click(detachedUnlink)
    expect(mockShowConfirm).not.toHaveBeenCalled()
    expect(mockAuthedFetch.mock.calls.some((call) => call[1] === 'DELETE')).toBe(false)

    await act(async () => {
      listB.resolve(listResult([linkedTrader('user-b', 'Beta')]))
    })
    await screen.findByText('Beta')
    const listBCall = mockAuthedFetch.mock.calls.find(
      (call) => call[0] === '/api/traders/linked' && call[1] === 'GET' && call[2] === jwt('user-b')
    )
    expect(listBCall?.[5]).toEqual({
      expectedUserId: 'user-b',
      expectedSessionGeneration: generationB,
    })
  })

  it('does not unlink B when an A confirmation resolves after switching accounts', async () => {
    const confirmation = deferred<boolean>()
    mockShowConfirm.mockReturnValue(confirmation.promise)
    mockAuthedFetch.mockImplementation(
      (url: string, method: string, accessToken: string | null) => {
        if (url === '/api/traders/linked' && method === 'GET') {
          const userId = accessToken === jwt('user-a') ? 'user-a' : 'user-b'
          const label = userId === 'user-a' ? 'Alpha' : 'Beta'
          return Promise.resolve(listResult([linkedTrader(userId, label)]))
        }
        return Promise.resolve({ ok: true, status: 200, data: { data: { remaining_count: 0 } } })
      }
    )

    const view = render(<TraderLinksSection userId="user-a" />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'unlinkAccount' }))
    expect(mockShowConfirm).toHaveBeenCalledTimes(1)

    act(() => {
      switchToUserB(() => view.rerender(<TraderLinksSection userId="user-b" />))
    })
    await screen.findByText('Beta')
    await act(async () => confirmation.resolve(true))

    expect(mockAuthedFetch.mock.calls.some((call) => call[1] === 'DELETE')).toBe(false)
    expect(mockShowToast).not.toHaveBeenCalledWith('traderUnlinked', 'success')
  })

  it('binds unlink to the loaded owner and exact captured token', async () => {
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url === '/api/traders/linked' && method === 'GET') {
        return Promise.resolve(listResult([linkedTrader('user-a', 'Alpha')]))
      }
      if (url === '/api/traders/linked' && method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { data: { remaining_count: 0 } },
        })
      }
      return Promise.resolve({ ok: false, status: 500, data: {} })
    })

    render(<TraderLinksSection userId="user-a" />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'unlinkAccount' }))

    await waitFor(() =>
      expect(mockAuthedFetch.mock.calls.some((call) => call[1] === 'DELETE')).toBe(true)
    )
    const unlinkCall = mockAuthedFetch.mock.calls.find((call) => call[1] === 'DELETE')
    expect(unlinkCall?.[2]).toBe(jwt('user-a'))
    expect(unlinkCall?.[3]).toEqual({ id: linkedTrader('user-a', 'Alpha').id })
    expect(unlinkCall?.[5]).toEqual({
      expectedUserId: 'user-a',
      expectedSessionGeneration: mockAuth.sessionGeneration,
    })
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('fails closed when the server returns a row owned by another viewer', async () => {
    mockAuthedFetch.mockResolvedValue(listResult([linkedTrader('user-b', 'Foreign')]))

    render(<TraderLinksSection userId="user-a" />)

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('loadLinkedTradersFailed', 'error')
    )
    expect(screen.queryByText('Foreign')).not.toBeInTheDocument()
    expect(screen.getByText('noLinkedAccounts')).toBeInTheDocument()
  })

  it('rejects malformed nested stats before numeric rendering', async () => {
    mockAuthedFetch.mockResolvedValue(
      listResult([
        {
          ...linkedTrader('user-a', 'Malformed stats'),
          stats: {
            arena_score: '99.5',
            roi: 12,
            pnl: 50,
            rank: 1,
            handle: null,
            avatar_url: null,
          },
        },
      ])
    )

    render(<TraderLinksSection userId="user-a" />)

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('loadLinkedTradersFailed', 'error')
    )
    expect(screen.queryByText('Malformed stats')).not.toBeInTheDocument()
    expect(screen.getByText('noLinkedAccounts')).toBeInTheDocument()
  })
})
