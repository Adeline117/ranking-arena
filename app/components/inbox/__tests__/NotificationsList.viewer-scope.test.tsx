import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NotificationsList from '../NotificationsList'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import { selectScopedUnreadNotifications, useInboxStore } from '@/lib/stores/inboxStore'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import { NOTIFICATION_READER_CACHE_EPOCH } from '@/lib/notifications/ranking-change-fence'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function token(subject: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject })}.signature`
}

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    accessToken: token(userId),
    authChecked: true,
    categorizeError: jest.fn(),
    email: `${userId}@example.com`,
    getAuthHeaders: jest.fn(),
    getAuthHeadersAsync: jest.fn(),
    getToken: jest.fn(),
    isLoggedIn: true,
    loading: false,
    refreshSession: jest.fn(),
    requireAuth: jest.fn(),
    sessionGeneration,
    signOut: jest.fn(),
    user: { id: userId, user_metadata: {} } as AuthSessionReturn['user'],
    userId,
    viewerKey: `user:${userId}`,
  }
}

let currentAuth: AuthSessionReturn
const mockShowToast = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => currentAuth,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          all: 'All',
          noNotifications: 'No notifications',
          operationFailed: 'Operation failed',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

const originalFetch = global.fetch

describe('NotificationsList viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    useInboxStore.setState({
      ownerScopeKey: null,
      panelOpen: false,
      unreadMessages: 0,
      unreadNotifications: 0,
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('hides A immediately and rejects A mark-read completion after B takes over', async () => {
    const scopeA = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scopeA.sessionGeneration)
    const putA = deferred<{
      ok: boolean
      status: number
      json: () => Promise<Record<string, string>>
    }>()
    let getCount = 0
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/notifications') && (init?.method ?? 'GET') === 'GET') {
        getCount += 1
        return {
          ok: true,
          status: 200,
          json: async () =>
            getCount === 1
              ? {
                  notifications: [
                    {
                      actor_avatar_url: null,
                      actor_handle: null,
                      created_at: '2026-07-28T12:01:00.000Z',
                      id: 'unsafe-ranking-change',
                      link: '/trader/unsafe',
                      message: 'Raw rank #9 to #1',
                      read: false,
                      title: 'Unsafe ranking payload',
                      type: 'ranking_change',
                    },
                    {
                      actor_avatar_url: null,
                      actor_handle: null,
                      created_at: '2026-07-28T12:00:00.000Z',
                      id: 'notice-a',
                      link: null,
                      message: 'Private A content',
                      read: false,
                      title: 'A notice',
                      type: 'system',
                    },
                  ],
                  unread_count: 2,
                }
              : { notifications: [], unread_count: 5 },
        } as Response
      }
      return putA.promise as Promise<Response>
    }) as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <NotificationsList variant="page" />
      </QueryClientProvider>
    )

    expect(await screen.findByText('A notice')).toBeInTheDocument()
    expect(screen.queryByText('Unsafe ranking payload')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('A notice'))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <NotificationsList variant="page" />
      </QueryClientProvider>
    )

    expect(screen.queryByText('A notice')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(selectScopedUnreadNotifications(useInboxStore.getState(), scopeB)).toBe(5)
    )
    expect(
      queryClient.getQueryData([
        'notifications',
        NOTIFICATION_READER_CACHE_EPOCH,
        scopeB.viewerKey,
        scopeB.sessionGeneration,
      ])
    ).toBeDefined()

    putA.resolve({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed' }),
    })
    await act(async () => {
      await putA.promise
      await Promise.resolve()
    })

    expect(selectScopedUnreadNotifications(useInboxStore.getState(), scopeB)).toBe(5)
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(screen.queryByText('A notice')).not.toBeInTheDocument()
  })
})
