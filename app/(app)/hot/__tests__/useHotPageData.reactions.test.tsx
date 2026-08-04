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

const POST_ID = '44444444-4444-4444-8444-444444444444'
const ACTOR_ID = '55555555-5555-4555-8555-555555555555'

const rawPost = {
  id: POST_ID,
  group_id: null,
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
  id: POST_ID,
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

function postsPage(posts: unknown[]) {
  return {
    success: true,
    data: { posts },
    meta: {
      pagination: { limit: 30, offset: 0, has_more: false },
      timestamp: '2026-08-03T12:00:00.000Z',
    },
  }
}

function reactionEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: {
        action: 'added',
        actor_id: ACTOR_ID,
        post_id: POST_ID,
        requested_reaction: 'up',
        reaction: 'up',
        like_count: 6,
        dislike_count: 2,
        ...overrides,
      },
      meta: { timestamp: '2026-08-03T12:00:01.000Z' },
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
      userId: ACTOR_ID,
      viewerKey: `user:${ACTOR_ID}`,
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
      json: () => Promise.resolve(postsPage([rawPost])),
    })
  })

  it('synchronizes canonical and compatibility counts in the list and open post', async () => {
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    act(() => result.current.handleOpenPost(result.current.hotPosts[0]))
    await waitFor(() => expect(result.current.openPost?.id).toBe(POST_ID))
    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.toggleReaction(POST_ID, 'up')
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

  it('locks same-frame requests and adopts one exact count receipt', async () => {
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.toggleReaction(POST_ID, 'up')
      duplicate = result.current.toggleReaction(POST_ID, 'up')
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      request.resolve(reactionEnvelope({ like_count: 7, dislike_count: 2 }))
      await Promise.all([first, duplicate])
    })

    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 7,
      like_count: 7,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: 'up',
    })
  })

  it('does not mutate from a wrong-actor ACK and releases the lock for retry', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(
        reactionEnvelope({ actor_id: '66666666-6666-4666-8666-666666666666', like_count: 99 })
      )
      .mockResolvedValueOnce(reactionEnvelope())
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    await act(async () => result.current.toggleReaction(POST_ID, 'up'))
    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: null,
    })
    expect(mockShowToast).toHaveBeenCalledWith('actionFailedRetry', 'error')

    await act(async () => result.current.toggleReaction(POST_ID, 'up'))
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
