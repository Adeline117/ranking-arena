import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetchPostCommentsPage = jest.fn()
const mockAuthedFetch = jest.fn()
const mockFetch = jest.fn()
const mockCreatePostReactionRequestId = jest.fn()
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
jest.mock('@/lib/posts/post-reaction-client-contract', () => {
  const actual = jest.requireActual('@/lib/posts/post-reaction-client-contract')
  return {
    ...actual,
    createPostReactionRequestId: () => mockCreatePostReactionRequestId(),
  }
})

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
const REACTION_REQUEST_ID_1 = '00000000000000000000000000000001'
const REACTION_REQUEST_ID_2 = '00000000000000000000000000000002'
const REACTION_REQUEST_ID_3 = '00000000000000000000000000000003'

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

function reactionEnvelope(
  requestId = REACTION_REQUEST_ID_1,
  desiredReaction: 'up' | 'down' | null = 'up',
  overrides: Record<string, unknown> = {}
) {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: {
        actor_id: ACTOR_ID,
        post_id: POST_ID,
        request_id: requestId,
        operation: 'set_reaction',
        desired_reaction: desiredReaction,
        action: desiredReaction === null ? 'removed' : 'added',
        reaction: desiredReaction,
        like_count: desiredReaction === 'up' ? 6 : 5,
        dislike_count: desiredReaction === 'down' ? 3 : 2,
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
    mockCreatePostReactionRequestId.mockReset()
    mockCreatePostReactionRequestId
      .mockReturnValueOnce(REACTION_REQUEST_ID_1)
      .mockReturnValueOnce(REACTION_REQUEST_ID_2)
      .mockReturnValue(REACTION_REQUEST_ID_3)
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
      request.resolve(
        reactionEnvelope(REACTION_REQUEST_ID_1, 'up', {
          action: 'changed',
          like_count: 8,
          dislike_count: 3,
        })
      )
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
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/posts/${POST_ID}/like`,
      'POST',
      'token-1',
      {
        operation: 'set_reaction',
        request_id: REACTION_REQUEST_ID_1,
        desired_reaction: 'up',
      },
      15_000,
      { expectedUserId: ACTOR_ID, expectedSessionGeneration: 1 }
    )
  })

  it('serializes two same-frame up clicks as up then null', async () => {
    const firstResponse = deferred<unknown>()
    const secondResponse = deferred<unknown>()
    mockAuthedFetch
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.toggleReaction(POST_ID, 'up')
      second = result.current.toggleReaction(POST_ID, 'up')
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.hotPosts[0].user_reaction).toBeNull()

    firstResponse.resolve(reactionEnvelope(REACTION_REQUEST_ID_1, 'up'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(result.current.hotPosts[0].user_reaction).toBeNull()

    secondResponse.resolve(reactionEnvelope(REACTION_REQUEST_ID_2, null))
    await act(async () => {
      await Promise.all([first, second])
    })

    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: null,
    })
  })

  it('coalesces three same-frame up clicks when the latest desired state matches the in-flight command', async () => {
    const response = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let first!: Promise<void>
    let second!: Promise<void>
    let third!: Promise<void>
    act(() => {
      first = result.current.toggleReaction(POST_ID, 'up')
      second = result.current.toggleReaction(POST_ID, 'up')
      third = result.current.toggleReaction(POST_ID, 'up')
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.hotPosts[0].user_reaction).toBe('up')

    response.resolve(reactionEnvelope(REACTION_REQUEST_ID_1, 'up'))
    await act(async () => {
      await Promise.all([first, second, third])
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 6,
      like_count: 6,
      user_reaction: 'up',
    })
  })

  it('replays transport and malformed-ACK uncertainty with one request id without rolling back newer intent', async () => {
    const replay = deferred<unknown>()
    const newerAttempt = deferred<unknown>()
    mockAuthedFetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(replay.promise)
      .mockReturnValueOnce(newerAttempt.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let up!: Promise<void>
    let down!: Promise<void>
    act(() => {
      up = result.current.toggleReaction(POST_ID, 'up')
      down = result.current.toggleReaction(POST_ID, 'down')
    })

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(mockAuthedFetch.mock.calls[1][3]).toEqual(mockAuthedFetch.mock.calls[0][3])
    expect(mockAuthedFetch.mock.calls[1][3]).toEqual({
      operation: 'set_reaction',
      request_id: REACTION_REQUEST_ID_1,
      desired_reaction: 'up',
    })

    replay.resolve({ ok: true, status: 200, data: { success: true } })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(3))
    expect(mockAuthedFetch.mock.calls[2][3]).toEqual({
      operation: 'set_reaction',
      request_id: REACTION_REQUEST_ID_2,
      desired_reaction: 'down',
    })

    newerAttempt.resolve({ ok: false, status: 403, data: { error: 'forbidden' } })
    await act(async () => {
      await Promise.all([up, down])
    })

    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 3,
      dislike_count: 3,
      user_reaction: 'down',
    })
    expect(mockShowToast).toHaveBeenCalledWith('forbidden', 'error')
  })

  it('serializes a newer down intent and keeps the older up ACK from restoring it', async () => {
    const firstResponse = deferred<unknown>()
    const secondResponse = deferred<unknown>()
    mockAuthedFetch
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise)
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let up!: Promise<void>
    act(() => {
      up = result.current.toggleReaction(POST_ID, 'up')
    })
    await waitFor(() => expect(result.current.hotPosts[0].user_reaction).toBe('up'))

    let down!: Promise<void>
    act(() => {
      down = result.current.toggleReaction(POST_ID, 'down')
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.hotPosts[0].user_reaction).toBe('down')

    firstResponse.resolve(reactionEnvelope(REACTION_REQUEST_ID_1, 'up'))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(result.current.hotPosts[0].user_reaction).toBe('down')

    secondResponse.resolve(reactionEnvelope(REACTION_REQUEST_ID_2, 'down'))
    await act(async () => {
      await Promise.all([up, down])
    })

    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 3,
      dislike_count: 3,
      user_reaction: 'down',
    })
  })

  it('rolls back only after a definitive pre-commit rejection', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 403,
      data: { error: 'forbidden' },
    })
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
    expect(mockShowToast).toHaveBeenCalledWith('forbidden', 'error')
  })

  it('drops an exact late ACK after the viewer scope changes', async () => {
    const response = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const { result, rerender } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.toggleReaction(POST_ID, 'up')
    })
    await waitFor(() => expect(result.current.hotPosts[0].user_reaction).toBe('up'))

    const nextActor = '66666666-6666-4666-8666-666666666666'
    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-2',
      authChecked: true,
      email: null,
      userId: nextActor,
      viewerKey: `user:${nextActor}`,
      sessionGeneration: 2,
    })
    rerender()
    await waitFor(() => expect(result.current.hotPosts[0].user_reaction).toBeNull())

    response.resolve(reactionEnvelope(REACTION_REQUEST_ID_1, 'up', { like_count: 99 }))
    await act(async () => mutation)

    expect(result.current.hotPosts[0].user_reaction).toBeNull()
    expect(result.current.hotPosts[0].like_count).not.toBe(99)
  })

  it('keeps a possibly committed intent after a wrong-actor ACK, then sends a new absolute intent', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(
        reactionEnvelope(REACTION_REQUEST_ID_1, 'up', {
          actor_id: '66666666-6666-4666-8666-666666666666',
          like_count: 99,
        })
      )
      .mockResolvedValueOnce(
        reactionEnvelope(REACTION_REQUEST_ID_1, 'up', {
          actor_id: '66666666-6666-4666-8666-666666666666',
          like_count: 99,
        })
      )
      .mockResolvedValueOnce(reactionEnvelope(REACTION_REQUEST_ID_2, 'down'))
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.loadingPosts).toBe(false))

    await act(async () => result.current.toggleReaction(POST_ID, 'up'))
    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 6,
      like_count: 6,
      dislikes: 2,
      dislike_count: 2,
      user_reaction: 'up',
    })
    expect(mockShowToast).toHaveBeenCalledWith('actionFailedRetry', 'error')
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthedFetch.mock.calls[1][3]).toEqual(mockAuthedFetch.mock.calls[0][3])

    await act(async () => result.current.toggleReaction(POST_ID, 'down'))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(mockAuthedFetch.mock.calls[2][3]).toEqual({
      operation: 'set_reaction',
      request_id: REACTION_REQUEST_ID_2,
      desired_reaction: 'down',
    })
    expect(result.current.hotPosts[0]).toMatchObject({
      likes: 5,
      like_count: 5,
      dislikes: 3,
      dislike_count: 3,
      user_reaction: 'down',
    })
  })
})
