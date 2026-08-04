import { act, renderHook } from '@testing-library/react'
import { usePostComments, type Comment } from '../usePostComments'

const mockAuthedFetch = jest.fn()
const mockReserveReactionIntentFetch = jest.fn()
const mockSetStoreComments = jest.fn()
const mockAddStoreComment = jest.fn()
const mockUpdatePostCommentCount = jest.fn()
const mockOpenLoginModal = jest.fn()
const REACTION_ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const REACTION_POST_ID = '22222222-2222-4222-8222-222222222222'
const REACTION_COMMENT_ID = '33333333-3333-4333-8333-333333333333'
const REACTION_COMMENT_ID_2 = '44444444-4444-4444-8444-444444444444'
const REACTION_REQUEST_ID = '0123456789abcdef0123456789abcdef'
const REACTION_REQUEST_ID_2 = 'fedcba9876543210fedcba9876543210'
const REACTION_REQUEST_ID_3 = '11111111111111111111111111111111'
const REACTION_INTENT_SEQUENCE = '1'
const REACTION_TIMESTAMP = '2026-08-03T21:30:00.000Z'
const REACTION_INTENT_EXPIRES_AT = '2026-08-03T21:45:00.000Z'
const mockCreateCommentReactionRequestId = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) =>
    String(args[0]).endsWith('/comments/like/intents')
      ? mockReserveReactionIntentFetch(...args)
      : mockAuthedFetch(...args),
  getHttpErrorMessage: (_status: number, fallback: string) => fallback,
}))

jest.mock('@/lib/stores/postStore', () => ({
  usePostStore: {
    getState: () => ({
      setComments: mockSetStoreComments,
      addComment: mockAddStoreComment,
      updatePostCommentCount: mockUpdatePostCommentCount,
    }),
  },
}))

jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: { getState: () => ({ openLoginModal: mockOpenLoginModal }) },
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/comments/comment-reaction-client-contract', () => {
  const actual = jest.requireActual('@/lib/comments/comment-reaction-client-contract')
  return {
    ...actual,
    createCommentReactionRequestId: () => mockCreateCommentReactionRequestId(),
  }
})
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    content: 'comment',
    created_at: '2026-07-15T00:00:00.000Z',
    like_count: 2,
    dislike_count: 1,
    user_liked: false,
    user_disliked: false,
    ...overrides,
  }
}

function renderCommentsHook(
  options: {
    onCommentCountChange?: (postId: string, delta: number, absoluteCount?: number) => void
    showDangerConfirm?: (title: string, message: string) => Promise<boolean>
    currentUserId?: string | null
    viewerKey?: string
    sessionGeneration?: number
  } = {}
) {
  const showToast = jest.fn()
  const hook = renderHook(() =>
    usePostComments({
      accessToken: 'token',
      currentUserId: options.currentUserId,
      viewerKey: options.viewerKey,
      sessionGeneration: options.sessionGeneration,
      showToast,
      showDangerConfirm: options.showDangerConfirm || (async () => true),
      onCommentCountChange: options.onCommentCountChange,
      t: (key) => key,
    })
  )
  return { ...hook, showToast }
}

function renderReactionHook() {
  return renderCommentsHook({
    currentUserId: REACTION_ACTOR_ID,
    viewerKey: `user:${REACTION_ACTOR_ID}`,
    sessionGeneration: 1,
  })
}

function makeReactionComment(overrides: Partial<Comment> = {}): Comment {
  return makeComment({
    id: REACTION_COMMENT_ID,
    post_id: REACTION_POST_ID,
    ...overrides,
  })
}

function reactionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: REACTION_ACTOR_ID,
      post_id: REACTION_POST_ID,
      comment_id: REACTION_COMMENT_ID,
      request_id: REACTION_REQUEST_ID,
      operation: 'set_reaction',
      intent_sequence: REACTION_INTENT_SEQUENCE,
      desired_reaction: 'like',
      action: 'added',
      reaction: 'like',
      liked: true,
      disliked: false,
      like_count: 3,
      dislike_count: 1,
      replayed: false,
      ...overrides,
    },
    meta: { timestamp: REACTION_TIMESTAMP },
  }
}

function reactionIntentReceipt(
  body: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    success: true,
    data: {
      actor_id: REACTION_ACTOR_ID,
      post_id: REACTION_POST_ID,
      comment_id: body.comment_id,
      request_id: body.request_id,
      operation: 'reserve_reaction_intent',
      desired_reaction: body.desired_reaction,
      status: 'issued',
      intent_sequence: REACTION_INTENT_SEQUENCE,
      expires_at: REACTION_INTENT_EXPIRES_AT,
      replayed: false,
      ...overrides,
    },
    meta: { timestamp: REACTION_TIMESTAMP },
  }
}

async function flushReactionReservation() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function failedResult(status = 500) {
  return Promise.resolve({
    ok: false,
    status,
    data: { success: false, error: 'rejected' },
  })
}

function commentsPage(comments: Comment[], commentCount = comments.length) {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: { comments, post: { comment_count: commentCount } },
    },
  }
}

describe('usePostComments reactions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockCreateCommentReactionRequestId.mockReturnValue(REACTION_REQUEST_ID)
    mockReserveReactionIntentFetch.mockImplementation(
      (_url: string, _method: string, _token: string, body: Record<string, unknown>) =>
        Promise.resolve({ ok: true, status: 200, data: reactionIntentReceipt(body) })
    )
  })

  it('reads the latest loaded comment state instead of a stale callback closure', async () => {
    mockAuthedFetch.mockImplementation(() => failedResult(409))
    const { result } = renderReactionHook()
    const loaded = makeReactionComment({ user_liked: true, like_count: 8 })

    act(() => result.current.setComments([loaded]))
    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, loaded.id)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: true,
      user_disliked: false,
      like_count: 8,
      dislike_count: 1,
    })
  })

  it('rolls a rejected neutral-to-like command back to the exact neutral state', async () => {
    mockAuthedFetch.mockImplementation(() => failedResult(409))
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: false,
      like_count: 2,
      dislike_count: 1,
    })
  })

  it('restores dislike exactly when a dislike-to-like switch is rejected', async () => {
    mockAuthedFetch.mockImplementation(() => failedResult(409))
    const { result } = renderReactionHook()
    act(() =>
      result.current.setComments([
        makeReactionComment({ user_disliked: true, like_count: 2, dislike_count: 4 }),
      ])
    )

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 4,
    })
  })

  it('does not roll back a Realtime truth that exactly matches the optimistic projection', async () => {
    let resolveRequest!: (value: unknown) => void
    mockAuthedFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve
          })
      )
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    let request!: Promise<void>
    act(() => {
      request = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()
    const realtimeTruth = makeReactionComment({ user_liked: true, like_count: 3 })
    act(() => result.current.setComments([realtimeTruth]))

    await act(async () => {
      resolveRequest(failedResult(409))
      await request
    })

    expect(result.current.comments).toEqual([realtimeTruth])
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the latest projection when both retries and canonical read are uncertain', async () => {
    mockAuthedFetch.mockRejectedValue(new Error('offline'))
    const { result, showToast } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentDislike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 2,
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')
  })

  it('drains same-frame like then cancel intents in order without dropping the second click', async () => {
    mockCreateCommentReactionRequestId
      .mockReturnValueOnce(REACTION_REQUEST_ID)
      .mockReturnValueOnce(REACTION_REQUEST_ID_2)
    const resolvers: Array<(value: unknown) => void> = []
    mockAuthedFetch.mockImplementation(() => new Promise((resolve) => void resolvers.push(resolve)))
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    let firstRequest: Promise<void>
    let duplicateRequest: Promise<void>
    act(() => {
      firstRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
      duplicateRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      like_count: 2,
    })

    await act(async () => {
      resolvers[0]?.({
        ok: true,
        status: 200,
        data: reactionReceipt(),
      })
      await Promise.resolve()
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolvers[1]?.({
        ok: true,
        status: 200,
        data: reactionReceipt({
          request_id: REACTION_REQUEST_ID_2,
          desired_reaction: null,
          action: 'removed',
          reaction: null,
          liked: false,
          like_count: 2,
        }),
      })
      await Promise.all([firstRequest!, duplicateRequest!])
    })

    const bodies = mockAuthedFetch.mock.calls.map((call) => call[3])
    expect(bodies).toEqual([
      expect.objectContaining({ request_id: REACTION_REQUEST_ID, desired_reaction: 'like' }),
      expect.objectContaining({ request_id: REACTION_REQUEST_ID_2, desired_reaction: null }),
    ])
    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: false,
      like_count: 2,
      dislike_count: 1,
    })
  })

  it('coalesces three same-frame like clicks when the latest desired state matches the first ACK', async () => {
    mockCreateCommentReactionRequestId
      .mockReturnValueOnce(REACTION_REQUEST_ID)
      .mockReturnValueOnce(REACTION_REQUEST_ID_2)
      .mockReturnValueOnce(REACTION_REQUEST_ID_3)
    const resolvers: Array<(value: unknown) => void> = []
    mockAuthedFetch.mockImplementation(() => new Promise((resolve) => void resolvers.push(resolve)))
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    let first!: Promise<void>
    let second!: Promise<void>
    let third!: Promise<void>
    act(() => {
      first = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
      second = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
      third = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockCreateCommentReactionRequestId).toHaveBeenCalledTimes(3)
    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 3 })

    await act(async () => {
      resolvers[0]?.({ ok: true, status: 200, data: reactionReceipt() })
      await Promise.all([first, second, third])
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.comments[0]).toMatchObject({
      user_liked: true,
      user_disliked: false,
      like_count: 3,
      dislike_count: 1,
    })
  })

  it('keeps a newer dislike projection while an older like ACK drains first', async () => {
    mockCreateCommentReactionRequestId
      .mockReturnValueOnce(REACTION_REQUEST_ID)
      .mockReturnValueOnce(REACTION_REQUEST_ID_2)
    const resolvers: Array<(value: unknown) => void> = []
    mockAuthedFetch.mockImplementation(() => new Promise((resolve) => void resolvers.push(resolve)))
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    let likeRequest!: Promise<void>
    let dislikeRequest!: Promise<void>
    act(() => {
      likeRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
      dislikeRequest = result.current.toggleCommentDislike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()
    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 2,
    })

    await act(async () => {
      resolvers[0]?.({ ok: true, status: 200, data: reactionReceipt() })
      await Promise.resolve()
    })
    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
    })

    await act(async () => {
      resolvers[1]?.({
        ok: true,
        status: 200,
        data: reactionReceipt({
          request_id: REACTION_REQUEST_ID_2,
          desired_reaction: 'dislike',
          action: 'changed',
          reaction: 'dislike',
          liked: false,
          disliked: true,
          like_count: 2,
          dislike_count: 2,
        }),
      })
      await Promise.all([likeRequest, dislikeRequest])
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 2,
    })
  })

  it('retries one desired intent with the same request identity', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
      .mockResolvedValueOnce({ ok: true, status: 200, data: reactionReceipt() })
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(mockAuthedFetch.mock.calls[0]?.[3]).toEqual(mockAuthedFetch.mock.calls[1]?.[3])
    expect(mockAuthedFetch.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        request_id: REACTION_REQUEST_ID,
        desired_reaction: 'like',
      })
    )
    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 3 })
  })

  it('retries a lost reservation with one identity before applying its exact ticket', async () => {
    mockReserveReactionIntentFetch
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
      .mockImplementationOnce(
        (_url: string, _method: string, _token: string, body: Record<string, unknown>) =>
          Promise.resolve({
            ok: true,
            status: 200,
            data: reactionIntentReceipt(body, {
              status: 'replayed',
              intent_sequence: '42',
              replayed: true,
            }),
          })
      )
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: reactionReceipt({ intent_sequence: '42' }),
    })
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(mockReserveReactionIntentFetch).toHaveBeenCalledTimes(2)
    expect(mockReserveReactionIntentFetch.mock.calls[0]?.[3]).toEqual(
      mockReserveReactionIntentFetch.mock.calls[1]?.[3]
    )
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/posts/${REACTION_POST_ID}/comments/like`,
      'POST',
      'token',
      expect.objectContaining({
        request_id: REACTION_REQUEST_ID,
        intent_sequence: '42',
        desired_reaction: 'like',
      }),
      15_000,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reconciles canonical truth when another instance supersedes its ticket', async () => {
    const canonicalTruth = makeReactionComment({
      user_liked: false,
      user_disliked: true,
      like_count: 7,
      dislike_count: 5,
    })
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        data: {
          success: false,
          code: 'COMMENT_REACTION_STALE',
          error: 'Reaction intent is stale',
        },
      })
      .mockResolvedValueOnce(commentsPage([canonicalTruth], 1))
    const { result, showToast } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(result.current.comments).toEqual([canonicalTruth])
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('runs different comment lanes concurrently and accepts out-of-order ACKs independently', async () => {
    mockCreateCommentReactionRequestId
      .mockReturnValueOnce(REACTION_REQUEST_ID)
      .mockReturnValueOnce(REACTION_REQUEST_ID_2)
    const pending = new Map<
      string,
      { body: Record<string, unknown>; resolve: (value: unknown) => void }
    >()
    mockAuthedFetch.mockImplementation(
      (_url: string, _method: string, _token: string, body: Record<string, unknown>) =>
        new Promise((resolve) => {
          pending.set(String(body.comment_id), { body, resolve })
        })
    )
    const { result } = renderReactionHook()
    act(() =>
      result.current.setComments([
        makeReactionComment(),
        makeReactionComment({ id: REACTION_COMMENT_ID_2 }),
      ])
    )

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
      second = result.current.toggleCommentDislike(REACTION_POST_ID, REACTION_COMMENT_ID_2)
    })
    await flushReactionReservation()

    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending.get(REACTION_COMMENT_ID_2)?.resolve({
        ok: true,
        status: 200,
        data: reactionReceipt({
          comment_id: REACTION_COMMENT_ID_2,
          request_id: REACTION_REQUEST_ID_2,
          desired_reaction: 'dislike',
          reaction: 'dislike',
          liked: false,
          disliked: true,
          like_count: 2,
          dislike_count: 2,
        }),
      })
      await second
    })
    expect(result.current.comments[1]).toMatchObject({
      user_disliked: true,
      dislike_count: 2,
    })

    await act(async () => {
      pending.get(REACTION_COMMENT_ID)?.resolve({
        ok: true,
        status: 200,
        data: reactionReceipt(),
      })
      await first
    })
    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 3 })
    expect(result.current.comments[1]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 2,
    })
  })

  it('overlays an active reaction intent on a same-post canonical tree refresh', async () => {
    const serverA = makeReactionComment({ like_count: 5 })
    const serverB = makeReactionComment({
      id: REACTION_COMMENT_ID_2,
      content: 'updated sibling',
      like_count: 9,
    })
    mockAuthedFetch.mockResolvedValueOnce(commentsPage([serverA, serverB], 2))
    const { result } = renderReactionHook()
    await act(async () => result.current.loadComments(REACTION_POST_ID))

    let resolveMutation!: (value: unknown) => void
    let mutationCommitted = false
    mockAuthedFetch.mockImplementation((url: string) => {
      if (url.endsWith('/comments/like')) {
        return new Promise((resolve) => {
          resolveMutation = resolve
        })
      }
      return Promise.resolve(
        commentsPage(
          [
            mutationCommitted ? makeReactionComment({ user_liked: true, like_count: 6 }) : serverA,
            serverB,
          ],
          2
        )
      )
    })

    let reactionRequest!: Promise<void>
    act(() => {
      reactionRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()
    await act(async () => result.current.loadComments(REACTION_POST_ID))

    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 6 })
    expect(result.current.comments[1]).toMatchObject({ content: 'updated sibling', like_count: 9 })

    await act(async () => {
      mutationCommitted = true
      resolveMutation({
        ok: true,
        status: 200,
        data: reactionReceipt({ like_count: 6 }),
      })
      await reactionRequest
    })
    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 6 })
  })

  it('does not let an older ACK replace newer same-comment canonical counters', async () => {
    const initial = makeReactionComment()
    const canonicalTruth = makeReactionComment({ user_liked: true, like_count: 10 })
    mockAuthedFetch.mockResolvedValueOnce(commentsPage([initial], 1))
    const { result } = renderReactionHook()
    await act(async () => result.current.loadComments(REACTION_POST_ID))

    let resolveMutation!: (value: unknown) => void
    mockAuthedFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMutation = resolve
          })
      )
      .mockResolvedValueOnce(commentsPage([canonicalTruth], 1))
      .mockResolvedValueOnce(commentsPage([canonicalTruth], 1))

    let reactionRequest!: Promise<void>
    act(() => {
      reactionRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()
    await act(async () => result.current.loadComments(REACTION_POST_ID))
    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 10 })

    await act(async () => {
      resolveMutation({
        ok: true,
        status: 200,
        data: reactionReceipt({ like_count: 3 }),
      })
      await reactionRequest
    })

    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 10 })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(4)
  })

  it('does not roll a newer authoritative state back when it matches the optimistic reaction', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    mockAuthedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    let request: Promise<void>
    act(() => {
      request = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()

    act(() => {
      result.current.setComments([
        makeReactionComment({ user_liked: true, like_count: 20, dislike_count: 4 }),
      ])
    })

    await act(async () => {
      resolveRequest?.({
        ok: false,
        status: 500,
        data: { success: false, error: 'rejected' },
      })
      await request!
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: true,
      user_disliked: false,
      like_count: 20,
      dislike_count: 4,
    })
  })

  it('reconciles all reaction flags and counts from a successful response', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: reactionReceipt({
        desired_reaction: 'dislike',
        reaction: 'dislike',
        liked: false,
        disliked: true,
        like_count: 12,
        dislike_count: 5,
      }),
    })
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentDislike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 12,
      dislike_count: 5,
    })
  })

  it('accepts an absolute remove acknowledgement without toggling it back on', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: reactionReceipt({
        action: 'removed',
        desired_reaction: null,
        reaction: null,
        liked: false,
        disliked: false,
        like_count: 1,
      }),
    })
    const { result } = renderReactionHook()
    act(() =>
      result.current.setComments([makeReactionComment({ user_liked: true, like_count: 2 })])
    )

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: false,
      like_count: 1,
      dislike_count: 1,
    })
  })

  it.each([
    ['another actor', reactionReceipt({ actor_id: '44444444-4444-4444-8444-444444444444' })],
    ['another post', reactionReceipt({ post_id: '44444444-4444-4444-8444-444444444444' })],
    ['another comment', reactionReceipt({ comment_id: '44444444-4444-4444-8444-444444444444' })],
    ['another desired reaction', reactionReceipt({ desired_reaction: 'dislike' })],
    [
      'an extra receipt field',
      {
        ...reactionReceipt(),
        data: { ...reactionReceipt().data, invented: true },
      },
    ],
    ['a malformed envelope', { success: true, data: reactionReceipt().data }],
    ['a non-JSON 2xx body', null],
  ])('does not accept %s as comment reaction truth', async (_label, candidate) => {
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, data: candidate })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(result.current.comments[0]).toMatchObject({
      user_liked: true,
      user_disliked: false,
      like_count: 3,
      dislike_count: 1,
    })
  })

  it('requires exact 200 and forwards a bounded, viewer-scoped abort signal', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: true, status: 201, data: reactionReceipt() })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
      .mockResolvedValueOnce({ ok: false, status: 503, data: null })
    const { result } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    await act(async () => {
      await result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })

    expect(mockReserveReactionIntentFetch).toHaveBeenCalledWith(
      `/api/posts/${REACTION_POST_ID}/comments/like/intents`,
      'POST',
      'token',
      {
        operation: 'reserve_reaction_intent',
        request_id: REACTION_REQUEST_ID,
        comment_id: REACTION_COMMENT_ID,
        desired_reaction: 'like',
      },
      15_000,
      {
        expectedUserId: REACTION_ACTOR_ID,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      }
    )
    expect(mockAuthedFetch).toHaveBeenNthCalledWith(
      1,
      `/api/posts/${REACTION_POST_ID}/comments/like`,
      'POST',
      'token',
      {
        operation: 'set_reaction',
        request_id: REACTION_REQUEST_ID,
        comment_id: REACTION_COMMENT_ID,
        intent_sequence: REACTION_INTENT_SEQUENCE,
        desired_reaction: 'like',
      },
      15_000,
      {
        expectedUserId: REACTION_ACTOR_ID,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      }
    )
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(result.current.comments[0]).toMatchObject({ user_liked: true, like_count: 3 })
  })

  it('aborts an in-flight reaction when the viewer scope changes', async () => {
    let requestSignal: AbortSignal | undefined
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { signal: AbortSignal }
      ) =>
        new Promise((resolve) => {
          requestSignal = scope.signal
          scope.signal.addEventListener(
            'abort',
            () => resolve({ ok: false, status: 0, data: null }),
            { once: true }
          )
        })
    )
    const showToast = jest.fn()
    const { result, rerender } = renderHook(
      (props: { actorId: string; generation: number }) =>
        usePostComments({
          accessToken: `token-${props.actorId}`,
          currentUserId: props.actorId,
          viewerKey: `user:${props.actorId}`,
          sessionGeneration: props.generation,
          showToast,
          showDangerConfirm: async () => true,
          t: (key) => key,
        }),
      { initialProps: { actorId: REACTION_ACTOR_ID, generation: 1 } }
    )
    act(() => result.current.setComments([makeReactionComment()]))

    let reactionRequest!: Promise<void>
    act(() => {
      reactionRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()
    rerender({ actorId: '44444444-4444-4444-8444-444444444444', generation: 2 })
    await act(async () => reactionRequest)

    expect(requestSignal?.aborted).toBe(true)
    expect(result.current.comments).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('aborts an in-flight reaction when the visible post changes', async () => {
    const nextPostId = '55555555-5555-4555-8555-555555555555'
    let requestSignal: AbortSignal | undefined
    mockAuthedFetch.mockImplementation((url: string, ...args: unknown[]) => {
      if (!url.endsWith('/comments/like')) {
        return Promise.resolve({ ok: false, status: 503, data: null })
      }
      const scope = args[4] as { signal: AbortSignal }
      requestSignal = scope.signal
      return new Promise((resolve) => {
        scope.signal.addEventListener(
          'abort',
          () => resolve({ ok: false, status: 0, data: null }),
          { once: true }
        )
      })
    })
    const { result, showToast } = renderReactionHook()
    act(() => result.current.setComments([makeReactionComment()]))

    let reactionRequest!: Promise<void>
    act(() => {
      reactionRequest = result.current.toggleCommentLike(REACTION_POST_ID, REACTION_COMMENT_ID)
    })
    await flushReactionReservation()
    await act(async () => {
      await result.current.loadComments(nextPostId)
      await reactionRequest
    })

    expect(requestSignal?.aborted).toBe(true)
    expect(result.current.comments).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })
})

describe('usePostComments post switching', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('does not let an older post request overwrite a newer post response', async () => {
    const requests = new Map<string, (value: unknown) => void>()
    mockAuthedFetch.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          requests.set(url, resolve)
        })
    )
    const { result } = renderCommentsHook()

    let firstLoad: Promise<void>
    let secondLoad: Promise<void>
    act(() => {
      firstLoad = result.current.loadComments('post-a')
      secondLoad = result.current.loadComments('post-b')
    })

    const commentB = makeComment({ id: 'comment-b', content: 'new post' })
    await act(async () => {
      requests.get('/api/posts/post-b/comments?sort=best')?.({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { comments: [commentB], post: { comment_count: 1 } },
        },
      })
      await secondLoad!
    })

    const commentA = makeComment({ id: 'comment-a', content: 'old post' })
    await act(async () => {
      requests.get('/api/posts/post-a/comments?sort=best')?.({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { comments: [commentA], post: { comment_count: 1 } },
        },
      })
      await firstLoad!
    })

    expect(result.current.comments).toEqual([commentB])
    expect(mockSetStoreComments).toHaveBeenCalledTimes(1)
    expect(mockSetStoreComments).toHaveBeenCalledWith('post-b', expect.any(Array))
    expect(result.current.loadingComments).toBe(false)
  })

  it('preserves the visible comment tree when a same-post refresh fails', async () => {
    const existing = makeComment({ id: 'comment-existing' })
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { comments: [existing], post: { comment_count: 1 } },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        data: { success: false, error: 'unavailable' },
      })
    const { result } = renderCommentsHook()

    await act(async () => result.current.loadComments('post-a'))
    await act(async () => result.current.loadComments('post-a'))

    expect(result.current.comments).toEqual([existing])
    expect(result.current.loadingComments).toBe(false)
  })

  it('resets reply target, edit, and expansion state when switching posts', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: { comments: [], post: { comment_count: 0 } } },
    })
    const { result } = renderCommentsHook()
    const comment = makeComment()

    await act(async () => result.current.loadComments('post-a'))
    act(() => {
      result.current.setComments([comment])
      result.current.setReplyingTo({ commentId: comment.id, handle: 'author' })
      result.current.setExpandedReplies({ [comment.id]: true })
      result.current.startEditComment(comment)
    })

    await act(async () => result.current.loadComments('post-b'))

    expect(result.current.replyingTo).toBeNull()
    expect(result.current.expandedReplies).toEqual({})
    expect(result.current.editingComment).toBeNull()
  })

  it('cancels only the edit target named by the caller', () => {
    const { result } = renderCommentsHook()
    const commentA = makeComment({ id: 'comment-a', content: 'A' })
    const commentB = makeComment({ id: 'comment-b', content: 'B' })

    act(() => result.current.startEditComment(commentA))
    expect(result.current.editingComment).toEqual({ id: 'comment-a', content: 'A' })

    act(() => result.current.startEditComment(commentB))
    act(() => result.current.cancelEditComment(commentA.id))
    expect(result.current.editingComment).toEqual({ id: 'comment-b', content: 'B' })

    act(() => result.current.cancelEditComment(commentB.id))
    expect(result.current.editingComment).toBeNull()
  })

  it('does not let an old failed submit overwrite the new post comments', async () => {
    let resolveOldSubmit: ((value: unknown) => void) | undefined
    const commentB = makeComment({ id: 'comment-b', content: 'post B comment' })
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url === '/api/posts/post-a/comments?sort=best') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { success: true, data: { comments: [], post: { comment_count: 0 } } },
        })
      }
      if (url === '/api/posts/post-a/comments' && method === 'POST') {
        return new Promise((resolve) => {
          resolveOldSubmit = resolve
        })
      }
      if (url === '/api/posts/post-b/comments?sort=best') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            success: true,
            data: { comments: [commentB], post: { comment_count: 1 } },
          },
        })
      }
      throw new Error(`Unexpected request: ${method} ${url}`)
    })
    const onCommentCountChange = jest.fn()
    const { result } = renderCommentsHook({ onCommentCountChange })

    await act(async () => result.current.loadComments('post-a'))

    let oldSubmit: Promise<boolean>
    act(() => {
      oldSubmit = result.current.submitComment('post-a', 'post A failed draft')
    })

    await act(async () => result.current.loadComments('post-b'))
    expect(result.current.comments).toEqual([commentB])

    await act(async () => {
      resolveOldSubmit?.({
        ok: false,
        status: 409,
        data: { success: false, error: 'rejected' },
      })
      await oldSubmit!
    })

    expect(result.current.comments).toEqual([commentB])
    expect(onCommentCountChange).toHaveBeenCalledWith('post-a', 1)
    expect(onCommentCountChange).toHaveBeenCalledWith('post-a', 0, 0)
  })

  it('does not delete the old post comment after switching posts during confirmation', async () => {
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined
    const showDangerConfirm = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve
        })
    )
    const commentA = makeComment({ id: 'comment-a' })
    const commentB = makeComment({ id: 'comment-b' })
    mockAuthedFetch.mockImplementation((url: string) => {
      if (url === '/api/posts/post-a/comments?sort=best') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            success: true,
            data: { comments: [commentA], post: { comment_count: 1 } },
          },
        })
      }
      if (url === '/api/posts/post-b/comments?sort=best') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            success: true,
            data: { comments: [commentB], post: { comment_count: 1 } },
          },
        })
      }
      throw new Error(`Unexpected mutation: ${url}`)
    })
    const { result } = renderCommentsHook({ showDangerConfirm })

    await act(async () => result.current.loadComments('post-a'))
    let deletion: Promise<void>
    act(() => {
      deletion = result.current.deleteComment('post-a', commentA.id)
    })
    await act(async () => result.current.loadComments('post-b'))

    await act(async () => {
      resolveConfirmation?.(true)
      await deletion!
    })

    expect(result.current.comments).toEqual([commentB])
    expect(showDangerConfirm).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })
})

describe('usePostComments deletion counts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('subtracts a deleted root and all replies removed by the server cascade', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: { deleted_count: 3, comment_count: 8 } },
    })
    const onCommentCountChange = jest.fn()
    const { result } = renderCommentsHook({ onCommentCountChange })
    act(() =>
      result.current.setComments([
        makeComment({
          replies: [makeComment({ id: 'reply-1' }), makeComment({ id: 'reply-2' })],
        }),
      ])
    )

    await act(async () => {
      await result.current.deleteComment('post-1', 'comment-1')
    })

    expect(result.current.comments).toEqual([])
    expect(onCommentCountChange).toHaveBeenCalledWith('post-1', -3, 8)
  })

  it('subtracts only one when deleting a reply', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: { deleted_count: 1, comment_count: 4 } },
    })
    const onCommentCountChange = jest.fn()
    const { result } = renderCommentsHook({ onCommentCountChange })
    act(() =>
      result.current.setComments([makeComment({ replies: [makeComment({ id: 'reply-1' })] })])
    )

    await act(async () => {
      await result.current.deleteComment('post-1', 'reply-1')
    })

    expect(result.current.comments[0].replies).toEqual([])
    expect(onCommentCountChange).toHaveBeenCalledWith('post-1', -1, 4)
  })

  it('accepts a delete 404 only after canonical reconciliation proves the comment absent', async () => {
    mockAuthedFetch.mockImplementation((_url: string, method: string) =>
      method === 'DELETE'
        ? Promise.resolve({
            ok: false,
            status: 404,
            data: { success: false, error: 'already hidden' },
          })
        : Promise.resolve({
            ok: true,
            status: 200,
            data: {
              success: true,
              data: { comments: [], post: { comment_count: 0 } },
            },
          })
    )
    const onCommentCountChange = jest.fn()
    const { result, showToast } = renderCommentsHook({ onCommentCountChange })
    act(() => result.current.setComments([makeComment()]))

    await act(async () => result.current.deleteComment('post-1', 'comment-1'))

    expect(result.current.comments).toEqual([])
    expect(onCommentCountChange).toHaveBeenCalledWith('post-1', 0, 0)
    expect(showToast).toHaveBeenCalledWith('deleted', 'success')
  })

  it.each([
    undefined,
    { deleted_count: 0, comment_count: 4 },
    { deleted_count: 1, comment_count: -1 },
    { deleted_count: '1', comment_count: 4 },
  ])('does not remove UI for an invalid delete acknowledgement: %o', async (acknowledgement) => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: acknowledgement },
    })
    const onCommentCountChange = jest.fn()
    const { result } = renderCommentsHook({ onCommentCountChange })
    const comment = makeComment()
    act(() => result.current.setComments([comment]))

    await act(async () => {
      await result.current.deleteComment('post-1', comment.id)
    })

    expect(result.current.comments).toEqual([comment])
    expect(onCommentCountChange).not.toHaveBeenCalled()
  })
})

describe('usePostComments viewer scope', () => {
  type ScopeProps = {
    accessToken: string | null
    currentUserId: string | null
    authChecked: boolean
    viewerKey: string
    sessionGeneration: number
  }

  function renderScopedHook(initialProps: ScopeProps) {
    const showToast = jest.fn()
    const hook = renderHook(
      (props: ScopeProps) =>
        usePostComments({
          ...props,
          showToast,
          showDangerConfirm: async () => true,
          t: (key) => key,
        }),
      { initialProps }
    )
    return { ...hook, showToast }
  }

  const userA: ScopeProps = {
    accessToken: 'token-a1',
    currentUserId: 'user-a',
    authChecked: true,
    viewerKey: 'user:user-a',
    sessionGeneration: 1,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('waits for pending auth and loads after A resolves', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { comments: [makeComment()], post: { comment_count: 1 } },
      },
    })
    const { result, rerender } = renderScopedHook({
      accessToken: null,
      currentUserId: null,
      authChecked: false,
      viewerKey: 'pending',
      sessionGeneration: 0,
    })

    await act(async () => result.current.loadComments('post-1'))
    expect(mockAuthedFetch).not.toHaveBeenCalled()

    rerender(userA)
    await act(async () => result.current.loadComments('post-1'))
    expect(result.current.comments).toHaveLength(1)
  })

  it('waits silently instead of showing a false login prompt while auth is pending', async () => {
    const { result } = renderScopedHook({
      accessToken: null,
      currentUserId: null,
      authChecked: false,
      viewerKey: 'pending',
      sessionGeneration: 0,
    })

    let acknowledged: boolean | undefined
    await act(async () => {
      acknowledged = await result.current.submitComment('post-1', 'wait for hydration')
    })

    expect(acknowledged).toBe(false)
    expect(mockOpenLoginModal).not.toHaveBeenCalled()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('discards an A GET that resolves after B becomes active', async () => {
    const requests = new Map<string, (value: unknown) => void>()
    mockAuthedFetch.mockImplementation(
      (_url: string, _method: string, token: string) =>
        new Promise((resolve) => {
          requests.set(token, resolve)
        })
    )
    const commentA = makeComment({ id: 'comment-a', content: 'A private state' })
    const commentB = makeComment({ id: 'comment-b', content: 'B state' })
    const { result, rerender } = renderScopedHook(userA)

    let loadA!: Promise<void>
    act(() => {
      loadA = result.current.loadComments('post-1')
    })
    rerender({
      accessToken: 'token-b',
      currentUserId: 'user-b',
      authChecked: true,
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    let loadB!: Promise<void>
    act(() => {
      loadB = result.current.loadComments('post-1')
    })

    await act(async () => {
      requests.get('token-b')?.({
        ok: true,
        status: 200,
        data: { success: true, data: { comments: [commentB], post: { comment_count: 1 } } },
      })
      await loadB
    })
    await act(async () => {
      requests.get('token-a1')?.({
        ok: true,
        status: 200,
        data: { success: true, data: { comments: [commentA], post: { comment_count: 1 } } },
      })
      await loadA
    })

    expect(result.current.comments).toEqual([commentB])
  })

  it('never exposes A comments during the first B render before cleanup effects', async () => {
    const snapshots: Array<{ viewerKey: string; commentIds: string[] }> = []
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: {
          comments: [makeComment({ id: 'comment-a' })],
          post: { comment_count: 1 },
        },
      },
    })
    const showToast = jest.fn()
    const { result, rerender } = renderHook(
      (props: ScopeProps) => {
        const value = usePostComments({
          ...props,
          showToast,
          showDangerConfirm: async () => true,
          t: (key) => key,
        })
        snapshots.push({
          viewerKey: props.viewerKey,
          commentIds: value.comments.map((comment) => comment.id),
        })
        return value
      },
      { initialProps: userA }
    )

    await act(async () => result.current.loadComments('post-1'))
    rerender({
      accessToken: 'token-b',
      currentUserId: 'user-b',
      authChecked: true,
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })

    expect(
      snapshots
        .filter((snapshot) => snapshot.viewerKey === 'user:user-b')
        .every((snapshot) => !snapshot.commentIds.includes('comment-a'))
    ).toBe(true)
  })

  it('fails A reply and edit-target interaction state empty during the first B render', async () => {
    const snapshots: Array<{
      viewerKey: string
      replyingTo: string | null
      editingComment: string | null
      expanded: boolean
    }> = []
    const showToast = jest.fn()
    const { result, rerender } = renderHook(
      (props: ScopeProps) => {
        const value = usePostComments({
          ...props,
          showToast,
          showDangerConfirm: async () => true,
          t: (key) => key,
        })
        snapshots.push({
          viewerKey: props.viewerKey,
          replyingTo: value.replyingTo?.commentId ?? null,
          editingComment: value.editingComment?.id ?? null,
          expanded: value.expandedReplies['comment-a'] ?? false,
        })
        return value
      },
      { initialProps: userA }
    )
    const commentA = makeComment({ id: 'comment-a', content: 'A private text' })

    act(() => {
      result.current.setComments([commentA])
      result.current.setReplyingTo({ commentId: commentA.id, handle: 'alice' })
      result.current.setExpandedReplies({ [commentA.id]: true })
      result.current.startEditComment(commentA)
    })
    rerender({
      accessToken: 'token-b',
      currentUserId: 'user-b',
      authChecked: true,
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })

    expect(snapshots.filter((snapshot) => snapshot.viewerKey === 'user:user-b')[0]).toEqual({
      viewerKey: 'user:user-b',
      replyingTo: null,
      editingComment: null,
      expanded: false,
    })
  })

  it('rejects stale create and reply callbacks after the visible post changes', async () => {
    const parent = makeComment({ id: 'parent', post_id: 'post-a' })
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { comments: [parent], post: { comment_count: 1 } },
      },
    })
    const onCommentCountChange = jest.fn()
    const { result } = renderHook(() =>
      usePostComments({
        ...userA,
        showToast: jest.fn(),
        showDangerConfirm: async () => true,
        onCommentCountChange,
        t: (key) => key,
      })
    )
    await act(async () => result.current.loadComments('post-a'))
    const staleCreate = result.current.submitComment
    const staleReply = result.current.submitReply

    await act(async () => result.current.loadComments('post-b'))
    mockAuthedFetch.mockClear()
    onCommentCountChange.mockClear()
    await act(async () => {
      await staleCreate('post-a', 'A create')
      await staleReply('post-a', parent.id, 'A reply')
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(onCommentCountChange).not.toHaveBeenCalled()
  })

  it('clears a loaded tree immediately when the same viewer loses resource access', async () => {
    const onResourceAbsent = jest.fn()
    const onCommentCountChange = jest.fn()
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: {
            comments: [makeComment({ id: 'formerly-visible' })],
            post: { comment_count: 1 },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        data: { error: 'Post not found' },
      })
    const { result } = renderHook(() =>
      usePostComments({
        ...userA,
        showToast: jest.fn(),
        showDangerConfirm: async () => true,
        onCommentCountChange,
        onResourceAbsent,
        t: (key) => key,
      })
    )

    await act(async () => result.current.loadComments('post-1'))
    expect(result.current.comments).toHaveLength(1)
    await act(async () => result.current.loadComments('post-1'))

    expect(result.current.comments).toEqual([])
    expect(onResourceAbsent).toHaveBeenCalledWith('post-1')
    expect(onCommentCountChange).toHaveBeenLastCalledWith('post-1', 0, 0)
  })

  it('preserves comments across a same-A token refresh', async () => {
    const comment = makeComment()
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: { comments: [comment], post: { comment_count: 1 } } },
    })
    const { result, rerender } = renderScopedHook(userA)
    await act(async () => result.current.loadComments('post-1'))

    rerender({ ...userA, accessToken: 'token-a2' })

    expect(result.current.comments).toEqual([comment])
  })

  it('ignores an old A mutation ACK after logout', async () => {
    let resolveSubmit!: (value: unknown) => void
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { success: true, data: { comments: [], post: { comment_count: 0 } } },
    })
    const { result, rerender, showToast } = renderScopedHook(userA)
    await act(async () => result.current.loadComments('post-1'))
    mockAuthedFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
    )
    let submission!: Promise<boolean>
    act(() => {
      submission = result.current.submitComment('post-1', 'A text')
    })

    rerender({
      accessToken: null,
      currentUserId: null,
      authChecked: true,
      viewerKey: 'anon',
      sessionGeneration: 2,
    })
    await act(async () => {
      resolveSubmit({
        ok: true,
        status: 201,
        data: {
          success: true,
          data: {
            comment: {
              id: 'comment-a',
              post_id: 'post-1',
              user_id: 'user-a',
              content: 'A text',
              parent_id: null,
              like_count: 0,
              dislike_count: 0,
              created_at: '2026-07-15T00:00:00.000Z',
              updated_at: '2026-07-15T00:00:00.000Z',
            },
          },
        },
      })
      await submission
    })

    expect(result.current.comments).toEqual([])
    await expect(submission).resolves.toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('accepts a sanitized strict ACK and returns a successful acknowledgement', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { comments: [], post: { comment_count: 0 } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        data: {
          success: true,
          data: {
            comment: {
              id: 'comment-a',
              post_id: 'post-1',
              user_id: 'user-a',
              content: 'hello',
              parent_id: null,
              like_count: 0,
              dislike_count: 0,
              created_at: '2026-07-15T00:00:00.000Z',
              updated_at: '2026-07-15T00:00:00.000Z',
            },
          },
        },
      })
    const { result } = renderScopedHook(userA)
    await act(async () => result.current.loadComments('post-1'))

    let acknowledged: boolean | undefined
    await act(async () => {
      acknowledged = await result.current.submitComment('post-1', '<b>hello</b>')
    })

    expect(acknowledged).toBe(true)
    expect(mockAuthedFetch).toHaveBeenLastCalledWith(
      '/api/posts/post-1/comments',
      'POST',
      'token-a1',
      { content: '<b>hello</b>' },
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: 1 }
    )
    expect(result.current.comments[0].content).toBe('hello')
  })

  it('returns a successful reply acknowledgement only for the expected actor and parent', async () => {
    const parent = makeComment({ id: 'parent', post_id: 'post-1', replies: [] })
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { comments: [parent], post: { comment_count: 1 } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        data: {
          success: true,
          data: {
            comment: {
              id: 'reply-a',
              post_id: 'post-1',
              user_id: 'user-a',
              content: 'reply',
              parent_id: 'parent',
              like_count: 0,
              dislike_count: 0,
              created_at: '2026-07-15T00:00:00.000Z',
              updated_at: '2026-07-15T00:00:00.000Z',
            },
          },
        },
      })
    const { result } = renderScopedHook(userA)
    await act(async () => result.current.loadComments('post-1'))

    let acknowledged: boolean | undefined
    await act(async () => {
      acknowledged = await result.current.submitReply('post-1', 'parent', '  <b>reply</b>  ')
    })

    expect(acknowledged).toBe(true)
    expect(mockAuthedFetch).toHaveBeenLastCalledWith(
      '/api/posts/post-1/comments',
      'POST',
      'token-a1',
      { content: '<b>reply</b>', parent_id: 'parent' },
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: 1 }
    )
    expect(result.current.comments[0].replies?.[0]).toMatchObject({
      id: 'reply-a',
      content: 'reply',
      parent_id: 'parent',
    })
  })
})
