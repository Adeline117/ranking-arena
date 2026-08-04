import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockAuthedFetch = jest.fn()
const mockShowToast = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'token-a', 1)

const translations: Record<string, string> = {
  loadFollowingFailed: 'Failed to load following',
  myFollowing: 'Following',
  noFollowing: 'You are not following anyone',
  noFollowingCta: 'Discover traders',
  retry: 'Retry',
}

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => translations[key] ?? key,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => {
    if (
      auth.loading ||
      !auth.authChecked ||
      !auth.userId ||
      !auth.accessToken ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      return null
    }
    return {
      accessToken: auth.accessToken,
      email: auth.email,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
    }
  },
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/ui/Breadcrumb', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/app/components/ui/PageHeader', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}))

jest.mock('@/app/components/ui/Skeleton', () => ({
  ListSkeleton: () => <div>Loading following</div>,
}))

jest.mock('@/app/components/ui/EmptyState', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <div>{title}</div>,
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({ title, retry }: { title: string; retry: () => void }) => (
    <div role="alert">
      <span>{title}</span>
      <button onClick={retry}>Retry</button>
    </div>
  ),
}))

jest.mock('@/app/components/ui/Avatar', () => ({
  __esModule: true,
  default: ({ name }: { name: string }) => <span>{name} avatar</span>,
}))

jest.mock('@/app/components/ui/PullToRefreshWrapper', () => ({
  __esModule: true,
  default: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => Promise<void>
  }) => (
    <div>
      <button onClick={onRefresh}>Refresh following</button>
      {children}
    </div>
  ),
}))

jest.mock('@/app/components/base', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    Box: ({
      children,
      onClick,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', { ...props, onClick }, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('span', null, children),
  }
})

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

jest.mock('@/lib/tracking', () => ({
  trackInteraction: jest.fn(),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

import FollowingPageClient from '../FollowingPageClient'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

const alice = {
  id: 'alice-id',
  identity_key: 'binance_futures:alice-id',
  handle: 'Alice',
  type: 'trader',
  source: 'binance_futures',
  platform: 'binance_futures',
  roi: 12,
  arena_score: 88,
}

describe('FollowingPageClient load errors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 'token-a', 1)
  })

  it('shows a persistent retry state instead of a false empty state after initial failure', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ error: 'Unavailable' }, 503))
      .mockResolvedValueOnce(response({ items: [alice], hasMore: false }))

    render(<FollowingPageClient />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.queryByText('You are not following anyone')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the last successful list visible when refresh fails and clears the error on retry', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ items: [alice], hasMore: false }))
      .mockResolvedValueOnce(response({ error: 'Unavailable' }, 503))
      .mockResolvedValueOnce(response({ items: [alice], hasMore: false }))

    render(<FollowingPageClient />)
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh following' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load following')
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(screen.queryByText('You are not following anyone')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
  })

  it('remounts private list state and drops an old unfollow after an account switch', async () => {
    let resolveUnfollow:
      | ((value: { data: Record<string, unknown>; ok: boolean; status: number }) => void)
      | undefined
    mockAuthedFetch.mockImplementation((_url: string, method: string, token: string) => {
      if (method === 'POST') {
        return new Promise((resolve) => {
          resolveUnfollow = resolve
        })
      }
      return Promise.resolve(
        response({
          hasMore: false,
          items:
            token === 'token-a'
              ? [alice]
              : [
                  {
                    ...alice,
                    handle: 'Bob private copy',
                  },
                ],
        })
      )
    })

    const { rerender } = render(<FollowingPageClient />)
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'followingUnfollowTitle' }))
    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/follow',
        'POST',
        'token-a',
        { action: 'unfollow', source: 'binance_futures', traderId: 'alice-id' },
        15_000,
        expect.objectContaining({
          expectedSessionGeneration: 1,
          expectedUserId: VIEWER_A,
          signal: expect.any(AbortSignal),
        })
      )
    )

    mockAuth = signedIn(VIEWER_B, 'token-b', 2)
    rerender(<FollowingPageClient />)
    expect((await screen.findAllByText('Bob private copy')).length).toBeGreaterThan(0)

    resolveUnfollow?.({
      data: {
        success: true,
        data: { following: false, traderId: 'alice-id', source: 'binance_futures' },
      },
      ok: true,
      status: 200,
    })
    await waitFor(() => expect(screen.getAllByText('Bob private copy').length).toBeGreaterThan(0))
    expect(mockShowToast).not.toHaveBeenCalledWith('followingUnfollowed', 'success')
  })

  it('restores the exact trader when an unfollow acknowledgement names another account', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ hasMore: false, items: [alice] }))
      .mockResolvedValueOnce(
        response({
          success: true,
          data: { following: false, traderId: 'alice-id', source: 'bybit' },
        })
      )

    render(<FollowingPageClient />)
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'followingUnfollowTitle' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('operationFailed', 'error'))
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(mockShowToast).not.toHaveBeenCalledWith('followingUnfollowed', 'success')
  })
})
