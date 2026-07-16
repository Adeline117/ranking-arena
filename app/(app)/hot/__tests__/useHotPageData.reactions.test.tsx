import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetchPostCommentsPage = jest.fn()
const mockAuthedFetch = jest.fn()
const mockFetch = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }
const mockSearchParams = new URLSearchParams()
const mockShowToast = jest.fn()
const mockT = (key: string) => key

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }),
}))
jest.mock('@/lib/api/comments-client', () => {
  const actual = jest.requireActual('@/lib/api/comments-client')
  return {
    ...actual,
    fetchPostCommentsPage: (...args: unknown[]) => mockFetchPostCommentsPage(...args),
  }
})
jest.mock('@/lib/hooks/useAuthSession', () => ({ useAuthSession: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: mockT }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: { getState: () => ({ openLoginModal: jest.fn() }) },
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn() },
  default: { error: jest.fn(), warn: jest.fn() },
}))

import { useHotPageData } from '../useHotPageData'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import type { Post } from '../types'

const mockUseAuthSession = useAuthSession as jest.Mock

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const rawPost = {
  id: 'post-1',
  group_name: 'General',
  title: 'Post',
  author_handle: 'user',
  content: 'body',
  comment_count: 1,
  like_count: 5,
  dislike_count: 2,
  hot_score: 1,
  view_count: 0,
  created_at: '2026-07-15T20:00:00.000Z',
  user_reaction: null,
}

const initialPost: Post = {
  id: 'post-1',
  group: 'General',
  title: 'Post',
  author: 'user',
  time: 'now',
  body: 'body',
  comments: 1,
  likes: 5,
  like_count: 5,
  dislikes: 2,
  dislike_count: 2,
  hotScore: 1,
  views: 0,
  created_at: '2026-07-15T20:00:00.000Z',
  user_reaction: null,
}

function reactionEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: {
        action: 'added',
        reaction: 'up',
        like_count: 6,
        dislike_count: 2,
        ...overrides,
      },
    },
  }
}

describe('useHotPageData reaction acknowledgements', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-1',
      authChecked: true,
      email: null,
      userId: 'user-1',
      viewerKey: 'user:user-1',
      sessionGeneration: 1,
    })
    mockFetchPostCommentsPage.mockResolvedValue({
      ok: true,
      status: 200,
      comments: [],
      commentCount: 1,
      hasMore: false,
    })
    global.fetch = mockFetch as never
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { posts: [rawPost] } }),
    })
  })

  it('synchronizes canonical and compatibility counts in the list and open post', async () => {
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    act(() => result.current.handleOpenPost(result.current.hotPosts[0]))
    await waitFor(() => expect(result.current.openPost?.id).toBe('post-1'))
    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.toggleReaction('post-1', 'up')
    })
    await act(async () => {
      request.resolve(reactionEnvelope({ action: 'changed', like_count: 8, dislike_count: 3 }))
      await mutation
    })

    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 8,
      like_count: 8,
      dislikes: 3,
      dislike_count: 3,
      user_reaction: 'up',
    })
    expect(result.current.openPost).toMatchObject({
      likes: 8,
      like_count: 8,
      dislikes: 3,
      dislike_count: 3,
      user_reaction: 'up',
    })
  })

  it('locks same-frame requests and preserves known counts when the ACK counts are null', async () => {
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.toggleReaction('post-1', 'up')
      duplicate = result.current.toggleReaction('post-1', 'up')
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      request.resolve(reactionEnvelope({ like_count: null, dislike_count: null }))
      await Promise.all([first, duplicate])
    })

    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: 'up',
    })
  })

  it('does not mutate from a malformed ACK and releases the lock for retry', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(reactionEnvelope({ action: undefined, like_count: 99 }))
      .mockResolvedValueOnce(reactionEnvelope())
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    await act(async () => result.current.toggleReaction('post-1', 'up'))
    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: null,
    })
    expect(mockShowToast).toHaveBeenCalledWith('actionFailedRetry', 'error')

    await act(async () => result.current.toggleReaction('post-1', 'up'))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 6,
      like_count: 6,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: 'up',
    })
  })
})
