import { act, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'

type MockAuthState = {
  user: { id: string } | null
  accessToken: string | null
  loading: boolean
}

let mockAuthState: MockAuthState = {
  user: { id: 'viewer-a' },
  accessToken: accessTokenFor('viewer-a'),
  loading: false,
}

const mockForceRefresh = jest.fn()

jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    forceRefresh: (...args: unknown[]) => mockForceRefresh(...args),
  },
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/post/components/PostCard', () => ({
  __esModule: true,
  default: ({ post }: { post: { id: string } }) => <div data-testid={`post-${post.id}`} />,
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

jest.mock('@/lib/design-tokens', () => ({
  tokens: {
    spacing: { 2: '8px', 5: '20px', 6: '24px', 10: '40px', 16: '64px' },
    radius: { md: '8px', lg: '12px' },
    colors: {
      text: { secondary: '#666', tertiary: '#999' },
      accent: { brand: '#00f' },
      white: '#fff',
    },
  },
}))

jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: { getState: () => ({ openLoginModal: jest.fn() }) },
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import FollowingFeed from '../FollowingFeed'

const originalFetch = global.fetch

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function accessTokenFor(viewerId: string) {
  const payload = Buffer.from(JSON.stringify({ sub: viewerId })).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.signature`
}

function apiResponse(postId: string, viewerId: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        following_count: 1,
        viewer_id: viewerId,
        posts: [
          {
            id: postId,
            created_at: new Date().toISOString(),
            like_count: 0,
            comment_count: 0,
            repost_count: 0,
          },
        ],
      },
    }),
  }
}

describe('FollowingFeed viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthState = {
      user: { id: 'viewer-a' },
      accessToken: accessTokenFor('viewer-a'),
      loading: false,
    }
    mockForceRefresh.mockReset()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('contains no browser call to the retired following-feed RPC', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/components/home/FollowingFeed.tsx'),
      'utf8'
    )

    expect(source).not.toContain(".rpc('get_following_feed'")
    expect(source).not.toContain("from '@/lib/supabase/client'")
  })

  it('uses the canonical API with the current bearer token', async () => {
    const tokenA = accessTokenFor('viewer-a')
    const fetchMock = jest.fn().mockResolvedValue(apiResponse('post-a', 'viewer-a'))
    global.fetch = fetchMock as typeof fetch

    render(<FollowingFeed />)

    await waitFor(() => expect(screen.getByTestId('post-post-a')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/posts?sort_by=following&limit=30',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${tokenA}` },
        cache: 'no-store',
      })
    )
  })

  it('discards a late viewer-A response after switching to viewer B', async () => {
    const viewerA = deferred<ReturnType<typeof apiResponse>>()
    const viewerB = deferred<ReturnType<typeof apiResponse>>()
    const fetchMock = jest
      .fn()
      .mockImplementationOnce(() => viewerA.promise)
      .mockImplementationOnce(() => viewerB.promise)
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<FollowingFeed />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    mockAuthState = {
      user: { id: 'viewer-b' },
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
    }
    rerender(<FollowingFeed />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      viewerB.resolve(apiResponse('post-b', 'viewer-b'))
      await viewerB.promise
    })
    expect(await screen.findByTestId('post-post-b')).toBeInTheDocument()

    await act(async () => {
      viewerA.resolve(apiResponse('post-a', 'viewer-a'))
      await viewerA.promise
    })
    expect(screen.queryByTestId('post-post-a')).not.toBeInTheDocument()
    expect(screen.getByTestId('post-post-b')).toBeInTheDocument()
  })

  it('fails empty immediately on logout and rejects an in-flight response', async () => {
    const viewerA = deferred<ReturnType<typeof apiResponse>>()
    global.fetch = jest.fn().mockReturnValue(viewerA.promise) as typeof fetch

    const { rerender } = render(<FollowingFeed />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

    mockAuthState = { user: null, accessToken: null, loading: false }
    rerender(<FollowingFeed />)
    expect(screen.getByText('followingFeedLoginPrompt')).toBeInTheDocument()

    await act(async () => {
      viewerA.resolve(apiResponse('post-a', 'viewer-a'))
      await viewerA.promise
    })
    expect(screen.queryByTestId('post-post-a')).not.toBeInTheDocument()
  })

  it('refreshes once after 401 and retries only for the same verified viewer', async () => {
    const refreshedToken = accessTokenFor('viewer-a')
    mockForceRefresh.mockResolvedValue(refreshedToken)
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce(apiResponse('post-a', 'viewer-a'))
    global.fetch = fetchMock as typeof fetch

    render(<FollowingFeed />)

    expect(await screen.findByTestId('post-post-a')).toBeInTheDocument()
    expect(mockForceRefresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ headers: { Authorization: `Bearer ${refreshedToken}` } })
    )
  })

  it('stops after one refresh when the retry is also unauthorized', async () => {
    mockForceRefresh.mockResolvedValue(accessTokenFor('viewer-a'))
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    })
    global.fetch = fetchMock as typeof fetch

    render(<FollowingFeed />)

    expect(await screen.findByText('loadFailed')).toBeInTheDocument()
    expect(mockForceRefresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry viewer A with a refreshed token after switching to viewer B', async () => {
    const refresh = deferred<string | null>()
    mockForceRefresh.mockReturnValue(refresh.promise)
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce(apiResponse('post-b', 'viewer-b'))
    global.fetch = fetchMock as typeof fetch

    const { rerender } = render(<FollowingFeed />)
    await waitFor(() => expect(mockForceRefresh).toHaveBeenCalledTimes(1))

    mockAuthState = {
      user: { id: 'viewer-b' },
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
    }
    rerender(<FollowingFeed />)
    expect(await screen.findByTestId('post-post-b')).toBeInTheDocument()

    await act(async () => {
      refresh.resolve(accessTokenFor('viewer-a'))
      await refresh.promise
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('post-post-a')).not.toBeInTheDocument()
  })

  it('fails empty when the rendered user and bearer token principals disagree', async () => {
    mockAuthState = {
      user: { id: 'viewer-a' },
      accessToken: accessTokenFor('viewer-b'),
      loading: false,
    }
    const fetchMock = jest.fn()
    global.fetch = fetchMock as typeof fetch

    render(<FollowingFeed />)

    expect(await screen.findByText('loadFailed')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a successful response attributed to another verified viewer', async () => {
    global.fetch = jest.fn().mockResolvedValue(apiResponse('post-b', 'viewer-b')) as typeof fetch

    render(<FollowingFeed />)

    expect(await screen.findByText('loadFailed')).toBeInTheDocument()
    expect(screen.queryByTestId('post-post-b')).not.toBeInTheDocument()
  })
})
