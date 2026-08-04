import { act, renderHook, waitFor } from '@testing-library/react'
import { useCallback, useState } from 'react'
import type { PostWithUserState } from '@/lib/types'
import { bookmarkPostTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'
import { usePostActions } from '../usePostActions'
import { trackEvent } from '@/lib/analytics/track'

const mockSetOpenPost = jest.fn()
const mockUpdatePostReaction = jest.fn()
const mockRouterPush = jest.fn()
const mockShowToast = jest.fn()
const mockSavePostToBookmarkFolder = jest.fn()
const mockTrackEvent = trackEvent as jest.Mock
const REACTION_ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const REACTION_POST_ID = '22222222-2222-4222-8222-222222222222'
const REACTION_TIMESTAMP = '2026-08-03T20:30:00.000Z'
const BOOKMARK_ACTOR_ID = REACTION_ACTOR_ID
const BOOKMARK_POST_ID = REACTION_POST_ID
const BOOKMARK_FOLDER_ID = '33333333-3333-4333-8333-333333333333'
const REPOST_ACTOR_ID = REACTION_ACTOR_ID
const REPOST_ROOT_POST_ID = '44444444-4444-4444-8444-444444444444'
const REPOST_CHILD_POST_ID = '55555555-5555-4555-8555-555555555555'
const REPOST_ROW_ID = '66666666-6666-4666-8666-666666666666'
const REPOST_OTHER_ACTOR_ID = '77777777-7777-4777-8777-777777777777'
const CUSTOM_POLL_ID = '88888888-8888-4888-8888-888888888888'
const OTHER_CUSTOM_POLL_ID = '99999999-9999-4999-8999-999999999999'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

jest.mock('@/lib/stores/postStore', () => ({
  usePostStore: {
    getState: () => ({ updatePostReaction: mockUpdatePostReaction }),
  },
}))

jest.mock('@/lib/utils/haptics', () => ({ haptic: jest.fn() }))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/bookmarks/folder-save-client', () => ({
  savePostToBookmarkFolder: (...args: unknown[]) => mockSavePostToBookmarkFolder(...args),
}))

const initialPost: PostWithUserState = {
  id: 'post-1',
  title: 'Post',
  content: 'Body',
  author_id: 'author-1',
  author_handle: 'author',
  poll_enabled: false,
  poll_bull: 0,
  poll_bear: 0,
  poll_wait: 0,
  like_count: 10,
  dislike_count: 2,
  comment_count: 0,
  bookmark_count: 3,
  repost_count: 0,
  view_count: 0,
  hot_score: 0,
  is_pinned: false,
  created_at: '2026-07-08T00:00:00.000Z',
  user_reaction: null,
  user_vote: null,
}

type ViewerProps = {
  accessToken: string | null
  currentUserId: string | null
  viewerKey: string
  sessionGeneration: number
}

const viewerA: ViewerProps = {
  accessToken: 'token-a',
  currentUserId: 'viewer-a',
  viewerKey: 'user:viewer-a',
  sessionGeneration: 1,
}

const reactionViewer: ViewerProps = {
  accessToken: 'reaction-token-a',
  currentUserId: REACTION_ACTOR_ID,
  viewerKey: `user:${REACTION_ACTOR_ID}`,
  sessionGeneration: 7,
}

const bookmarkViewer: ViewerProps = {
  accessToken: 'bookmark-token-a',
  currentUserId: BOOKMARK_ACTOR_ID,
  viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
  sessionGeneration: 8,
}

const repostViewer: ViewerProps = {
  accessToken: 'repost-token-a',
  currentUserId: REPOST_ACTOR_ID,
  viewerKey: `user:${REPOST_ACTOR_ID}`,
  sessionGeneration: 9,
}

function useAliasedPostActions(viewer: ViewerProps = viewerA) {
  const [post, setPost] = useState(initialPost)
  const setPosts = useCallback<React.Dispatch<React.SetStateAction<PostWithUserState[]>>>(
    (action) => {
      setPost((previous) => {
        const next =
          typeof action === 'function'
            ? (action as (posts: PostWithUserState[]) => PostWithUserState[])([previous])
            : action
        return next[0] ?? previous
      })
    },
    []
  )

  const actions = usePostActions({
    ...viewer,
    posts: [post],
    setPosts,
    openPost: post,
    setOpenPost: mockSetOpenPost,
    openPostAliasesPosts: true,
    showToast: mockShowToast,
    showDangerConfirm: async () => true,
    t: (key) => key,
  })

  return { actions, post, setPost }
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response
}

function responseWithJson(json: () => Promise<unknown>, ok = true, status = 200): Response {
  return { ok, status, json } as Response
}

function reactionReceiptForRequest(
  options: RequestInit | undefined,
  overrides: Record<string, unknown> = {}
) {
  const requestBody = parsedRequestBody(options)
  const desiredReaction = requestBody.desired_reaction
  return {
    success: true,
    data: {
      actor_id: REACTION_ACTOR_ID,
      post_id: REACTION_POST_ID,
      request_id: requestBody.request_id,
      operation: 'set_reaction',
      desired_reaction: desiredReaction,
      action: desiredReaction === null ? 'removed' : 'added',
      reaction: desiredReaction,
      like_count: 12,
      dislike_count: 3,
      ...overrides,
    },
    meta: { timestamp: REACTION_TIMESTAMP },
  }
}

function bookmarkReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: BOOKMARK_ACTOR_ID,
    post_id: BOOKMARK_POST_ID,
    request_id: requestId,
    operation: 'toggle',
    action: 'added',
    bookmarked: true,
    bookmark_count: 4,
    folder_id: BOOKMARK_FOLDER_ID,
    ...overrides,
  }
}

function bookmarkStatusReceipt(
  requestId: string,
  actorId = BOOKMARK_ACTOR_ID,
  postIds = [BOOKMARK_POST_ID],
  overrides: Record<string, unknown> = {}
) {
  return {
    actor_id: actorId,
    request_id: requestId,
    operation: 'status',
    post_ids: postIds,
    bookmarks: Object.fromEntries(postIds.map((postId) => [postId, true])),
    ...overrides,
  }
}

function repostReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: REPOST_ACTOR_ID,
    source_post_id: REPOST_ROOT_POST_ID,
    root_post_id: REPOST_ROOT_POST_ID,
    request_id: requestId,
    operation: 'create',
    action: 'created',
    repost_post_id: REPOST_ROW_ID,
    repost_count: 4,
    ...overrides,
  }
}

function builtInVoteReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: REACTION_ACTOR_ID,
    post_id: REACTION_POST_ID,
    request_id: requestId,
    operation: 'toggle',
    requested_choice: 'bull',
    action: 'added',
    vote: 'bull',
    poll: { bull: 4, bear: 2, wait: 1 },
    ...overrides,
  }
}

function customPollReadReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: REACTION_ACTOR_ID,
    post_id: REACTION_POST_ID,
    request_id: requestId,
    operation: 'read',
    action: 'found',
    poll: {
      id: CUSTOM_POLL_ID,
      question: 'Direction?',
      options: [
        { text: 'Up', votes: null },
        { text: 'Down', votes: null },
      ],
      type: 'single',
      end_at: null,
      is_expired: false,
      show_results: false,
      total_votes: null,
    },
    user_votes: [],
    ...overrides,
  }
}

function customPollVoteReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: REACTION_ACTOR_ID,
    post_id: REACTION_POST_ID,
    poll_id: CUSTOM_POLL_ID,
    request_id: requestId,
    operation: 'set_vote',
    action: 'voted',
    poll: {
      options: [
        { text: 'Up', votes: 2 },
        { text: 'Down', votes: 1 },
      ],
      total_votes: 3,
    },
    option_indexes: [0],
    ...overrides,
  }
}

function parsedRequestBody(options: RequestInit | undefined): Record<string, unknown> {
  expect(typeof options?.body).toBe('string')
  return JSON.parse(options?.body as string) as Record<string, unknown>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('usePostActions aliased detail state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/')
    global.fetch = jest.fn()
    mockSavePostToBookmarkFolder.mockResolvedValue({
      ok: true,
      acknowledgement: {
        status: 'added',
        user_id: '11111111-1111-4111-8111-111111111111',
        post_id: '22222222-2222-4222-8222-222222222222',
        bookmark_id: '33333333-3333-4333-8333-333333333333',
        folder_id: '44444444-4444-4444-8444-444444444444',
        bookmarked: true,
        bookmark_count: 4,
      },
    })
  })

  it('single-flights a pin scope and submits one stable desired state', async () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    const authorId = '33333333-3333-4333-8333-333333333333'
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const { result } = renderHook(() => useAliasedPostActions())
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: postId,
        author_id: authorId,
        group_id: null,
        is_pinned: false,
      }))
    })
    const event = { stopPropagation: jest.fn() } as unknown as React.MouseEvent

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.actions.handleTogglePin(result.current.post, event)
      duplicate = result.current.actions.handleTogglePin(result.current.post, event)
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith(`/api/posts/${postId}/pin`, {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer token-a',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ is_pinned: true }),
    })

    await act(async () => {
      response.resolve(
        jsonResponse({
          success: true,
          data: {
            post_id: postId,
            author_id: authorId,
            group_id: null,
            scope_type: 'author',
            scope_id: authorId,
            is_pinned: true,
            already_set: false,
            unpinned_count: 0,
            message: 'Pinned',
          },
        })
      )
      await Promise.all([first, duplicate])
    })

    expect(result.current.post.is_pinned).toBe(true)
    expect(mockShowToast).toHaveBeenCalledWith('Pinned', 'success')
  })

  it.each([{}, { success: true, extra: 'invented' }, { success: false }])(
    'keeps a post visible after a malformed 2xx delete acknowledgement %#',
    async (body) => {
      ;(global.fetch as jest.Mock).mockResolvedValue(jsonResponse(body))
      const { result } = renderHook(() => useAliasedPostActions())

      await act(async () => {
        await result.current.actions.handleDeletePost(result.current.post, {
          stopPropagation: jest.fn(),
        } as unknown as React.MouseEvent)
      })

      expect(mockSetOpenPost).not.toHaveBeenCalledWith(null)
      expect(mockShowToast).toHaveBeenCalledWith('deleteFailed', 'error')
    }
  )

  it('removes a post only after the exact delete acknowledgement', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ success: true }))
    const { result } = renderHook(() => useAliasedPostActions())

    await act(async () => {
      await result.current.actions.handleDeletePost(result.current.post, {
        stopPropagation: jest.fn(),
      } as unknown as React.MouseEvent)
    })

    expect(mockSetOpenPost).toHaveBeenCalledWith(null)
    expect(mockShowToast).toHaveBeenCalledWith('deleted', 'success')
  })

  it('single-flights delete confirmation and the destructive request', async () => {
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const { result } = renderHook(() => useAliasedPostActions())
    const event = { stopPropagation: jest.fn() } as unknown as React.MouseEvent

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.actions.handleDeletePost(result.current.post, event)
      duplicate = result.current.actions.handleDeletePost(result.current.post, event)
    })

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    expect(global.fetch).toHaveBeenCalledWith('/api/posts/post-1/delete', {
      method: 'DELETE',
      headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
    })

    await act(async () => {
      response.resolve(jsonResponse({ success: true }))
      await Promise.all([first, duplicate])
    })

    expect(mockSetOpenPost).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledWith('deleted', 'success')
  })

  it('adopts only the exact actor- and post-bound reaction receipt', async () => {
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(jsonResponse(reactionReceiptForRequest(options)))
    )
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    await act(async () => {
      await result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
    })

    expect(result.current.post).toMatchObject({
      like_count: 12,
      dislike_count: 3,
      user_reaction: 'up',
    })
    expect(mockSetOpenPost).not.toHaveBeenCalled()
    expect(mockUpdatePostReaction).toHaveBeenCalledWith(REACTION_POST_ID, {
      like_count: 12,
      dislike_count: 3,
      reaction: 'up',
    })
    expect(global.fetch).toHaveBeenCalledWith(`/api/posts/${REACTION_POST_ID}/like`, {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${reactionViewer.accessToken}`,
        'Content-Type': 'application/json',
      }),
      body: expect.any(String),
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
    expect(parsedRequestBody((global.fetch as jest.Mock).mock.calls[0][1])).toEqual({
      operation: 'set_reaction',
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      desired_reaction: 'up',
    })
  })

  it('does not let a bookmark ACK overwrite a concurrent reaction update', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    ;(global.fetch as jest.Mock).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    )
    const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
    })

    let bookmarkRequest: Promise<void>
    act(() => {
      bookmarkRequest = result.current.actions.handleBookmark(BOOKMARK_POST_ID)
    })
    act(() => {
      result.current.setPost((previous) => ({
        ...previous,
        like_count: 11,
        user_reaction: 'up',
      }))
    })

    await act(async () => {
      const requestBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[0][1])
      resolveFetch?.(jsonResponse(bookmarkReceipt(requestBody.request_id as string)))
      await bookmarkRequest!
    })

    expect(result.current.post).toMatchObject({
      like_count: 11,
      user_reaction: 'up',
      bookmark_count: 4,
    })
    expect(mockSetOpenPost).not.toHaveBeenCalled()
  })

  it.each([
    ['another actor', { actor_id: '44444444-4444-4444-8444-444444444444' }, 200],
    ['another post', { post_id: '44444444-4444-4444-8444-444444444444' }, 200],
    ['another request', { request_id: 'b'.repeat(32) }, 200],
    ['another operation', { operation: 'status' }, 200],
    ['an extra field', { invented: true }, 200],
    ['an exact receipt with a non-200 status', {}, 201],
  ])('rolls back a bookmark 2xx receipt bound to %s', async (_label, overrides, status) => {
    ;(global.fetch as jest.Mock).mockImplementation(async (_url: string, options?: RequestInit) => {
      const body = parsedRequestBody(options)
      return jsonResponse(
        bookmarkReceipt(body.request_id as string, overrides as Record<string, unknown>),
        true,
        status as number
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
      result.current.actions.setBookmarkCounts({ [BOOKMARK_POST_ID]: 3 })
      result.current.actions.setUserBookmarks({ [BOOKMARK_POST_ID]: false })
    })

    await act(async () => {
      await result.current.actions.handleBookmark(BOOKMARK_POST_ID)
    })

    expect(result.current.post.bookmark_count).toBe(3)
    expect(result.current.actions.userBookmarks[BOOKMARK_POST_ID]).toBe(false)
    expect(result.current.actions.bookmarkCounts[BOOKMARK_POST_ID]).toBe(3)
    expect(result.current.actions.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
    expect(mockShowToast).toHaveBeenCalledWith('operationFailed', 'error')
  })

  it('rolls back a non-JSON bookmark response and releases the lock', async () => {
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('not json')
        },
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('status is not json')
        },
      } as Response)
      .mockImplementationOnce(async (_url: string, options?: RequestInit) => {
        const body = parsedRequestBody(options)
        return jsonResponse(bookmarkReceipt(body.request_id as string))
      })
    const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
      result.current.actions.setBookmarkCounts({ [BOOKMARK_POST_ID]: 3 })
    })

    await act(async () => result.current.actions.handleBookmark(BOOKMARK_POST_ID))
    expect(result.current.post.bookmark_count).toBe(3)

    await act(async () => result.current.actions.handleBookmark(BOOKMARK_POST_ID))
    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(result.current.post.bookmark_count).toBe(4)
  })

  it('hard-times-out a failed status reconciliation and unlocks an exact retry', async () => {
    jest.useFakeTimers()
    try {
      const statusResponse = deferred<Response>()
      const lateStatusJson = jest.fn(async () =>
        bookmarkStatusReceipt('f'.repeat(32), BOOKMARK_ACTOR_ID, [BOOKMARK_POST_ID])
      )
      ;(global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('lost mutation acknowledgement')
          },
        } as Response)
        .mockReturnValueOnce(statusResponse.promise)
        .mockImplementationOnce(async (_url: string, options?: RequestInit) => {
          const body = parsedRequestBody(options)
          return jsonResponse(bookmarkReceipt(body.request_id as string))
        })
      const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
      act(() => {
        result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
        result.current.actions.setBookmarkCounts({ [BOOKMARK_POST_ID]: 3 })
      })

      let first!: Promise<void>
      act(() => {
        first = result.current.actions.handleBookmark(BOOKMARK_POST_ID)
      })
      await act(async () => Promise.resolve())
      expect(global.fetch).toHaveBeenCalledTimes(2)

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await first
      })
      expect(result.current.actions.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
      expect(result.current.actions.userBookmarks[BOOKMARK_POST_ID]).toBe(false)
      expect(result.current.actions.bookmarkCounts[BOOKMARK_POST_ID]).toBe(3)

      await act(async () => result.current.actions.handleBookmark(BOOKMARK_POST_ID))
      expect(global.fetch).toHaveBeenCalledTimes(3)
      expect(result.current.post.bookmark_count).toBe(4)

      await act(async () => {
        statusResponse.resolve(responseWithJson(lateStatusJson))
        await Promise.resolve()
      })
      expect(lateStatusJson).not.toHaveBeenCalled()
      expect(result.current.post.bookmark_count).toBe(4)
    } finally {
      jest.useRealTimers()
    }
  })

  it('recovers a timed-out bookmark from exact status truth and ignores its late ACK', async () => {
    jest.useFakeTimers()
    try {
      const firstResponse = deferred<Response>()
      const lateJson = jest.fn(async () => bookmarkReceipt('f'.repeat(32), { bookmark_count: 99 }))
      ;(global.fetch as jest.Mock)
        .mockReturnValueOnce(firstResponse.promise)
        .mockImplementationOnce(async (_url: string, options?: RequestInit) => {
          const body = parsedRequestBody(options)
          return jsonResponse(
            bookmarkStatusReceipt(
              body.request_id as string,
              BOOKMARK_ACTOR_ID,
              body.postIds as string[]
            )
          )
        })
      const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
      act(() => {
        result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
        result.current.actions.setBookmarkCounts({ [BOOKMARK_POST_ID]: 3 })
      })

      let first!: Promise<void>
      let duplicate!: Promise<void>
      act(() => {
        first = result.current.actions.handleBookmark(BOOKMARK_POST_ID)
        duplicate = result.current.actions.handleBookmark(BOOKMARK_POST_ID)
      })
      expect(global.fetch).toHaveBeenCalledTimes(1)

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await Promise.all([first, duplicate])
      })
      expect(result.current.post.bookmark_count).toBe(4)
      expect(result.current.actions.userBookmarks[BOOKMARK_POST_ID]).toBe(true)
      expect(result.current.actions.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(mockShowToast).toHaveBeenCalledWith('bookmarked', 'success')

      await act(async () => {
        firstResponse.resolve(responseWithJson(lateJson))
        await Promise.resolve()
      })
      expect(lateJson).not.toHaveBeenCalled()
      expect(result.current.post.bookmark_count).toBe(4)
    } finally {
      jest.useRealTimers()
    }
  })

  it('drops an uncertain bookmark reconciliation after the viewer scope changes', async () => {
    const statusResponse = deferred<Response>()
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('lost mutation acknowledgement')
        },
      } as Response)
      .mockReturnValueOnce(statusResponse.promise)
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: bookmarkViewer }
    )
    act(() => {
      result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
      result.current.actions.setBookmarkCounts({ [BOOKMARK_POST_ID]: 3 })
    })

    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.actions.handleBookmark(BOOKMARK_POST_ID)
    })
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    const statusBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[1][1])

    rerender({
      accessToken: 'bookmark-token-b',
      currentUserId: '44444444-4444-4444-8444-444444444444',
      viewerKey: 'user:44444444-4444-4444-8444-444444444444',
      sessionGeneration: 9,
    })
    await act(async () => {
      statusResponse.resolve(jsonResponse(bookmarkStatusReceipt(statusBody.request_id as string)))
      await mutation
    })

    expect(result.current.actions.userBookmarks).toEqual({})
    expect(result.current.actions.bookmarkCounts).toEqual({})
    expect(result.current.post.bookmark_count).toBe(3)
    expect(mockShowToast).not.toHaveBeenCalledWith('bookmarked', 'success')
  })

  it('reconciles an exact folder-save ACK and leaves modal closure to its caller', async () => {
    const { result } = renderHook(() => useAliasedPostActions())
    act(() => {
      result.current.actions.setBookmarkingPostId('post-1')
      result.current.actions.setShowBookmarkModal(true)
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleBookmarkToFolder(
        '44444444-4444-4444-8444-444444444444'
      )
    })

    expect(succeeded).toBe(true)
    expect(result.current.actions.showBookmarkModal).toBe(true)
    expect(result.current.actions.bookmarkingPostId).toBe('post-1')
    expect(result.current.actions.userBookmarks['post-1']).toBe(true)
    expect(result.current.post.bookmark_count).toBe(4)
    expect(mockSavePostToBookmarkFolder).toHaveBeenCalledWith({
      accessToken: viewerA.accessToken,
      userId: viewerA.currentUserId,
      postId: 'post-1',
      folderId: '44444444-4444-4444-8444-444444444444',
      sessionGeneration: viewerA.sessionGeneration,
    })
  })

  it('keeps folder state and modal retryable after an uncertain save failure', async () => {
    mockSavePostToBookmarkFolder.mockResolvedValue({
      ok: false,
      status: 0,
      error: null,
      stale: false,
    })
    const { result } = renderHook(() => useAliasedPostActions())
    act(() => {
      result.current.actions.setBookmarkingPostId('post-1')
      result.current.actions.setShowBookmarkModal(true)
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleBookmarkToFolder(
        '44444444-4444-4444-8444-444444444444'
      )
    })

    expect(succeeded).toBe(false)
    expect(result.current.actions.showBookmarkModal).toBe(true)
    expect(result.current.actions.bookmarkingPostId).toBe('post-1')
    expect(result.current.post.bookmark_count).toBe(3)
    expect(mockShowToast).toHaveBeenCalledWith('networkError', 'error')
  })

  it('drops a late folder-save acknowledgement after the viewer scope changes', async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof mockSavePostToBookmarkFolder>>) => void
    mockSavePostToBookmarkFolder.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: viewerA }
    )
    act(() => {
      result.current.actions.setBookmarkingPostId('post-1')
      result.current.actions.setShowBookmarkModal(true)
    })
    let request: Promise<boolean>
    act(() => {
      request = result.current.actions.handleBookmarkToFolder(
        '44444444-4444-4444-8444-444444444444'
      )
    })

    rerender({
      accessToken: 'token-b',
      currentUserId: 'viewer-b',
      viewerKey: 'user:viewer-b',
      sessionGeneration: 2,
    })
    let succeeded: boolean | undefined
    await act(async () => {
      resolveSave({
        ok: true,
        acknowledgement: {
          status: 'added',
          user_id: '11111111-1111-4111-8111-111111111111',
          post_id: '22222222-2222-4222-8222-222222222222',
          bookmark_id: '33333333-3333-4333-8333-333333333333',
          folder_id: '44444444-4444-4444-8444-444444444444',
          bookmarked: true,
          bookmark_count: 99,
        },
      })
      succeeded = await request!
    })

    expect(succeeded).toBe(false)
    expect(result.current.post.bookmark_count).toBe(3)
    expect(result.current.actions.userBookmarks).toEqual({})
    expect(mockShowToast).not.toHaveBeenCalledWith('bookmarked', 'success')
  })

  it('reverses one optimistic reaction delta after a definitive pre-commit rejection', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ success: false, error: 'rejected' }, false, 400)
    )
    const { result } = renderHook(() => useAliasedPostActions())

    await act(async () => {
      await result.current.actions.toggleReaction('post-1', 'up')
    })

    expect(result.current.post).toMatchObject({
      like_count: 10,
      dislike_count: 2,
      user_reaction: null,
    })
    expect(mockSetOpenPost).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['another actor', { actor_id: '33333333-3333-4333-8333-333333333333' }, 200],
    ['another post', { post_id: '33333333-3333-4333-8333-333333333333' }, 200],
    ['another request', { request_id: 'f'.repeat(32) }, 200],
    ['another desired reaction', { desired_reaction: 'down' }, 200],
    ['an extra receipt field', { invented: true }, 200],
    ['an exact body with a non-200 status', {}, 201],
  ])(
    'retains optimistic state after an uncertain response bound to %s',
    async (_name, overrides, status) => {
      ;(global.fetch as jest.Mock).mockImplementation((_url: string, options?: RequestInit) =>
        Promise.resolve(
          jsonResponse(reactionReceiptForRequest(options, overrides), true, status as number)
        )
      )
      const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
      act(() => {
        result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
      })

      await act(async () => {
        await result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      })

      expect(result.current.post).toMatchObject({
        like_count: 11,
        dislike_count: 2,
        user_reaction: 'up',
      })
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(mockUpdatePostReaction).not.toHaveBeenCalled()
      expect(mockShowToast).toHaveBeenCalled()
    }
  )

  it('retains optimistic state after two non-JSON 200 responses', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not json')
      },
    } as Response)
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    await act(async () => {
      await result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
    })

    expect(result.current.post).toMatchObject({
      like_count: 11,
      dislike_count: 2,
      user_reaction: 'up',
    })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(mockUpdatePostReaction).not.toHaveBeenCalled()
  })

  it('serializes two rapid same-button clicks and preserves the final removal intent', async () => {
    const firstResponse = deferred<Response>()
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(firstResponse.promise)
      .mockImplementation((_url: string, options?: RequestInit) =>
        Promise.resolve(jsonResponse(reactionReceiptForRequest(options)))
      )
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      second = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      const firstOptions = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
      firstResponse.resolve(jsonResponse(reactionReceiptForRequest(firstOptions)))
      await Promise.all([first, second])
    })

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(parsedRequestBody((global.fetch as jest.Mock).mock.calls[1][1])).toMatchObject({
      operation: 'set_reaction',
      desired_reaction: null,
    })
    expect(result.current.post).toMatchObject({
      like_count: 12,
      dislike_count: 3,
      user_reaction: null,
    })
    expect(mockUpdatePostReaction).toHaveBeenCalledTimes(1)
  })

  it('coalesces three rapid clicks when the latest desired state matches the in-flight command', async () => {
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    let first!: Promise<void>
    let second!: Promise<void>
    let third!: Promise<void>
    act(() => {
      first = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      second = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      third = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      const options = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
      response.resolve(jsonResponse(reactionReceiptForRequest(options)))
      await Promise.all([first, second, third])
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(result.current.post).toMatchObject({
      like_count: 12,
      dislike_count: 3,
      user_reaction: 'up',
    })
  })

  it('converges a newer opposite intent after an older command remains uncertain', async () => {
    let call = 0
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options?: RequestInit) => {
      call += 1
      if (call <= 2) {
        return Promise.resolve(
          jsonResponse({ success: false, error: 'upstream failed' }, false, 503)
        )
      }
      return Promise.resolve(jsonResponse(reactionReceiptForRequest(options)))
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      second = result.current.actions.toggleReaction(REACTION_POST_ID, 'down')
    })
    await act(async () => Promise.all([first, second]))

    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(parsedRequestBody((global.fetch as jest.Mock).mock.calls[2][1])).toMatchObject({
      operation: 'set_reaction',
      desired_reaction: 'down',
    })
    expect(result.current.post).toMatchObject({
      like_count: 12,
      dislike_count: 3,
      user_reaction: 'down',
    })
    expect(mockUpdatePostReaction).toHaveBeenCalledTimes(1)
  })

  it('does not roll back to stale truth when an older command is uncertain and the latest is rejected', async () => {
    let call = 0
    ;(global.fetch as jest.Mock).mockImplementation(() => {
      call += 1
      return Promise.resolve(
        call <= 2
          ? jsonResponse({ success: false, error: 'upstream failed' }, false, 503)
          : jsonResponse({ success: false, error: 'rejected' }, false, 400)
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      second = result.current.actions.toggleReaction(REACTION_POST_ID, 'down')
    })
    await act(async () => Promise.all([first, second]))

    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(result.current.post).toMatchObject({
      like_count: 10,
      dislike_count: 3,
      user_reaction: 'down',
    })
    expect(mockUpdatePostReaction).not.toHaveBeenCalled()
    expect(mockShowToast).toHaveBeenCalledWith('rejected', 'error')
  })

  it('replays one timed-out desired state without toggling it away', async () => {
    jest.useFakeTimers()
    try {
      const lateResponse = deferred<Response>()
      ;(global.fetch as jest.Mock)
        .mockReturnValueOnce(lateResponse.promise)
        .mockImplementation((_url: string, options?: RequestInit) =>
          Promise.resolve(jsonResponse(reactionReceiptForRequest(options, { action: 'unchanged' })))
        )
      const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
      act(() => {
        result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
      })

      let timedRequest!: Promise<void>
      act(() => {
        timedRequest = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      })
      const firstSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal
      expect(result.current.post.like_count).toBe(11)

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await timedRequest
      })

      expect(firstSignal.aborted).toBe(true)
      expect(result.current.post).toMatchObject({
        like_count: 12,
        dislike_count: 3,
        user_reaction: 'up',
      })
      expect(global.fetch).toHaveBeenCalledTimes(2)
      const firstBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[0][1])
      const retryBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[1][1])
      expect(retryBody).toEqual(firstBody)
      expect(mockShowToast).not.toHaveBeenCalled()
      await act(async () => {
        const firstOptions = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
        lateResponse.resolve(
          jsonResponse(reactionReceiptForRequest(firstOptions, { like_count: 99 }))
        )
        await Promise.resolve()
      })
      expect(result.current.post).toMatchObject({
        like_count: 12,
        dislike_count: 3,
        user_reaction: 'up',
      })
      expect(mockUpdatePostReaction).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not blindly roll back after both bounded attempts time out', async () => {
    jest.useFakeTimers()
    try {
      const firstResponse = deferred<Response>()
      const retryResponse = deferred<Response>()
      ;(global.fetch as jest.Mock)
        .mockReturnValueOnce(firstResponse.promise)
        .mockReturnValueOnce(retryResponse.promise)
      const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
      act(() => {
        result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
      })

      let request!: Promise<void>
      act(() => {
        request = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
      })
      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await Promise.resolve()
      })
      expect(global.fetch).toHaveBeenCalledTimes(2)
      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await request
      })

      expect(result.current.post).toMatchObject({
        like_count: 11,
        dislike_count: 2,
        user_reaction: 'up',
      })
      expect(mockUpdatePostReaction).not.toHaveBeenCalled()
      expect(mockShowToast).toHaveBeenCalledWith('requestTimeout', 'error')
    } finally {
      jest.useRealTimers()
    }
  })

  it('drops an exact late receipt after the viewer session changes', async () => {
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const viewerB: ViewerProps = {
      accessToken: 'reaction-token-b',
      currentUserId: '33333333-3333-4333-8333-333333333333',
      viewerKey: 'user:33333333-3333-4333-8333-333333333333',
      sessionGeneration: 8,
    }
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: reactionViewer }
    )
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    let request!: Promise<void>
    act(() => {
      request = result.current.actions.toggleReaction(REACTION_POST_ID, 'up')
    })

    rerender(viewerB)
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REACTION_POST_ID,
        like_count: 10,
        dislike_count: 2,
        user_reaction: null,
      }))
    })
    await act(async () => {
      const options = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
      response.resolve(jsonResponse(reactionReceiptForRequest(options, { like_count: 99 })))
      await request
    })

    expect(result.current.post).toMatchObject({
      like_count: 10,
      dislike_count: 2,
      user_reaction: null,
    })
    expect(mockUpdatePostReaction).not.toHaveBeenCalled()
  })

  it('reconciles the canonical repost count returned by the server', async () => {
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options: RequestInit) => {
      const body = parsedRequestBody(options)
      return Promise.resolve(jsonResponse(repostReceipt(body.request_id as string), true, 201))
    })
    const { result } = renderHook(() => useAliasedPostActions(repostViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
      }))
      result.current.actions.setShowRepostModal(REPOST_ROOT_POST_ID)
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost(REPOST_ROOT_POST_ID, 'worth sharing')
    })

    expect(succeeded).toBe(true)
    expect(result.current.post.repost_count).toBe(4)
    expect(mockSetOpenPost).not.toHaveBeenCalled()
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(parsedRequestBody(options)).toEqual({
      operation: 'create',
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      comment: 'worth sharing',
    })
    expect(options.cache).toBe('no-store')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    // The modal owns its local draft and closes itself after a successful ACK.
    expect(result.current.actions.showRepostModal).toBe(REPOST_ROOT_POST_ID)
  })

  it('does not write a canonical root count onto a clicked child repost', async () => {
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options: RequestInit) => {
      const body = parsedRequestBody(options)
      return Promise.resolve(
        jsonResponse(
          repostReceipt(body.request_id as string, {
            source_post_id: REPOST_CHILD_POST_ID,
            root_post_id: REPOST_ROOT_POST_ID,
          }),
          true,
          201
        )
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(repostViewer))
    act(() => {
      result.current.setPost((previous) => ({
        ...previous,
        id: REPOST_CHILD_POST_ID,
        original_post_id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
        repost_count: 0,
      }))
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost(REPOST_CHILD_POST_ID, 'worth sharing')
    })

    expect(succeeded).toBe(true)
    expect(result.current.post.repost_count).toBe(0)
    expect(mockSetOpenPost).not.toHaveBeenCalled()
  })

  it('coalesces rapid repost submissions into one request', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    ;(global.fetch as jest.Mock).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    )
    const { result } = renderHook(() => useAliasedPostActions(repostViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
      }))
    })

    let firstRequest: Promise<boolean>
    let duplicateRequest: Promise<boolean>
    act(() => {
      firstRequest = result.current.actions.handleRepost(REPOST_ROOT_POST_ID, 'worth sharing')
      duplicateRequest = result.current.actions.handleRepost(REPOST_ROOT_POST_ID, 'worth sharing')
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    await expect(duplicateRequest!).resolves.toBe(false)

    await act(async () => {
      const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
      const requestId = parsedRequestBody(options).request_id as string
      resolveFetch?.(jsonResponse(repostReceipt(requestId), true, 201))
      await expect(firstRequest!).resolves.toBe(true)
    })
  })

  it.each([
    ['actor', { actor_id: REPOST_OTHER_ACTOR_ID }],
    ['source post', { source_post_id: REPOST_CHILD_POST_ID }],
    ['root post', { root_post_id: REPOST_CHILD_POST_ID }],
    ['request nonce', { request_id: 'f'.repeat(32) }],
    ['operation', { operation: 'remove' }],
    ['action', { action: 'already_exists' }],
    ['count', { repost_count: -1 }],
  ])('rejects a created repost receipt bound to another %s', async (_name, overrides) => {
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options: RequestInit) => {
      const requestId = parsedRequestBody(options).request_id as string
      return Promise.resolve(jsonResponse(repostReceipt(requestId, overrides), true, 201))
    })
    const { result } = renderHook(() => useAliasedPostActions(repostViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
        repost_count: 2,
      }))
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost(REPOST_ROOT_POST_ID, 'share')
    })
    expect(succeeded).toBe(false)
    expect(result.current.post.repost_count).toBe(2)
    expect(mockTrackEvent).not.toHaveBeenCalledWith('post_repost', expect.anything())
    expect(mockShowToast).toHaveBeenCalledWith('repostFailed', 'error')
  })

  it('reconciles an exact 409 already-existing receipt without claiming a creation', async () => {
    ;(global.fetch as jest.Mock).mockImplementation((_url: string, options: RequestInit) => {
      const requestId = parsedRequestBody(options).request_id as string
      return Promise.resolve(
        jsonResponse(
          repostReceipt(requestId, { action: 'already_exists', repost_count: 7 }),
          false,
          409
        )
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(repostViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
        repost_count: 2,
      }))
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost(REPOST_ROOT_POST_ID, 'share')
    })

    expect(succeeded).toBe(false)
    expect(result.current.post.repost_count).toBe(7)
    expect(mockTrackEvent).not.toHaveBeenCalledWith('post_repost', expect.anything())
    expect(mockShowToast).toHaveBeenCalledWith('alreadyReposted', 'warning')
  })

  it('rejects the legacy loose 200 response without mutating last-known repost truth', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        post_id: REPOST_ROW_ID,
        root_post_id: REPOST_ROOT_POST_ID,
        repost_count: 99,
        message: 'Repost successful',
      })
    )
    const { result } = renderHook(() => useAliasedPostActions(repostViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
        repost_count: 2,
      }))
    })

    let succeeded: boolean | undefined
    await act(async () => {
      succeeded = await result.current.actions.handleRepost(REPOST_ROOT_POST_ID)
    })

    expect(succeeded).toBe(false)
    expect(result.current.post.repost_count).toBe(2)
    expect(mockShowToast).toHaveBeenCalledWith('repostFailed', 'error')
  })

  it('hard-times out a hanging repost fetch, unlocks retry, and ignores its late response', async () => {
    jest.useFakeTimers()
    try {
      const firstResponse = deferred<Response>()
      const lateJson = jest.fn(async () => repostReceipt('f'.repeat(32), { repost_count: 99 }))
      ;(global.fetch as jest.Mock)
        .mockReturnValueOnce(firstResponse.promise)
        .mockImplementationOnce((_url: string, options: RequestInit) => {
          const requestId = parsedRequestBody(options).request_id as string
          return Promise.resolve(
            jsonResponse(repostReceipt(requestId, { repost_count: 4 }), true, 201)
          )
        })
      const { result } = renderHook(() => useAliasedPostActions(repostViewer))
      act(() => {
        result.current.setPost((post) => ({
          ...post,
          id: REPOST_ROOT_POST_ID,
          author_id: REPOST_OTHER_ACTOR_ID,
          repost_count: 2,
        }))
      })

      let first!: Promise<boolean>
      act(() => {
        first = result.current.actions.handleRepost(REPOST_ROOT_POST_ID)
      })
      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await expect(first).resolves.toBe(false)
      })
      expect(result.current.post.repost_count).toBe(2)
      expect(result.current.actions.repostLoading[REPOST_ROOT_POST_ID]).toBe(false)

      await act(async () => {
        await expect(result.current.actions.handleRepost(REPOST_ROOT_POST_ID)).resolves.toBe(true)
      })
      expect(result.current.post.repost_count).toBe(4)

      await act(async () => {
        firstResponse.resolve(responseWithJson(lateJson, true, 201))
        await Promise.resolve()
      })
      expect(lateJson).not.toHaveBeenCalled()
      expect(result.current.post.repost_count).toBe(4)
    } finally {
      jest.useRealTimers()
    }
  })

  it('hard-times out repost JSON parsing and ignores the late exact receipt', async () => {
    jest.useFakeTimers()
    try {
      const lateBody = deferred<unknown>()
      const lateJson = jest.fn(() => lateBody.promise)
      ;(global.fetch as jest.Mock).mockResolvedValue(responseWithJson(lateJson, true, 201))
      const { result } = renderHook(() => useAliasedPostActions(repostViewer))
      act(() => {
        result.current.setPost((post) => ({
          ...post,
          id: REPOST_ROOT_POST_ID,
          author_id: REPOST_OTHER_ACTOR_ID,
          repost_count: 2,
        }))
      })

      let mutation!: Promise<boolean>
      act(() => {
        mutation = result.current.actions.handleRepost(REPOST_ROOT_POST_ID)
      })
      await act(async () => Promise.resolve())
      expect(lateJson).toHaveBeenCalledTimes(1)
      const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
      const requestId = parsedRequestBody(options).request_id as string

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await expect(mutation).resolves.toBe(false)
      })
      expect(result.current.post.repost_count).toBe(2)

      await act(async () => {
        lateBody.resolve(repostReceipt(requestId, { repost_count: 99 }))
        await Promise.resolve()
      })
      expect(result.current.post.repost_count).toBe(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('drops an exact repost receipt after viewer generation changes', async () => {
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const viewerB: ViewerProps = {
      accessToken: 'repost-token-b',
      currentUserId: REPOST_OTHER_ACTOR_ID,
      viewerKey: `user:${REPOST_OTHER_ACTOR_ID}`,
      sessionGeneration: 10,
    }
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: repostViewer }
    )
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_OTHER_ACTOR_ID,
        repost_count: 2,
      }))
    })

    let mutation!: Promise<boolean>
    act(() => {
      mutation = result.current.actions.handleRepost(REPOST_ROOT_POST_ID)
    })
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    const requestId = parsedRequestBody(options).request_id as string

    rerender(viewerB)
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REPOST_ROOT_POST_ID,
        author_id: REPOST_ACTOR_ID,
        repost_count: 50,
      }))
    })
    await act(async () => {
      response.resolve(jsonResponse(repostReceipt(requestId, { repost_count: 99 }), true, 201))
      await expect(mutation).resolves.toBe(false)
    })

    expect(result.current.post.repost_count).toBe(50)
    expect(result.current.actions.repostLoading).toEqual({})
  })

  it('serializes built-in choices behind one post lock and applies only an exact receipt', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (_url: string, options: RequestInit) => {
      const requestBody = parsedRequestBody(options)
      return jsonResponse(builtInVoteReceipt(requestBody.request_id as string))
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REACTION_POST_ID,
        poll_enabled: true,
        poll_bull: 1,
        poll_bear: 1,
        poll_wait: 1,
      }))
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.actions._toggleVote(REACTION_POST_ID, 'bull')
      second = result.current.actions._toggleVote(REACTION_POST_ID, 'bear')
    })
    await act(async () => Promise.all([first, second]))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(parsedRequestBody(options)).toEqual({
      operation: 'toggle',
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      choice: 'bull',
    })
    expect(options.cache).toBe('no-store')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(result.current.post).toMatchObject({
      poll_bull: 4,
      poll_bear: 2,
      poll_wait: 1,
      user_vote: 'bull',
    })
  })

  it('rejects a built-in vote receipt for another actor without changing last-known counts', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (_url: string, options: RequestInit) => {
      const requestBody = parsedRequestBody(options)
      return jsonResponse(
        builtInVoteReceipt(requestBody.request_id as string, {
          actor_id: REPOST_OTHER_ACTOR_ID,
        })
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: REACTION_POST_ID,
        poll_bull: 1,
        poll_bear: 2,
        poll_wait: 3,
      }))
    })

    await act(async () => result.current.actions._toggleVote(REACTION_POST_ID, 'bull'))

    expect(result.current.post).toMatchObject({
      poll_bull: 1,
      poll_bear: 2,
      poll_wait: 3,
      user_vote: null,
    })
    expect(mockShowToast).toHaveBeenCalledWith('voteFailed', 'error')
  })

  it('bounds built-in vote JSON parsing and ignores a body that resolves after timeout', async () => {
    jest.useFakeTimers()
    try {
      const lateBody = deferred<unknown>()
      ;(global.fetch as jest.Mock).mockResolvedValue(responseWithJson(() => lateBody.promise))
      const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
      act(() => {
        result.current.setPost((post) => ({
          ...post,
          id: REACTION_POST_ID,
          poll_bull: 1,
          poll_bear: 2,
          poll_wait: 3,
        }))
      })

      let mutation!: Promise<void>
      act(() => {
        mutation = result.current.actions._toggleVote(REACTION_POST_ID, 'bull')
      })
      await act(async () => Promise.resolve())
      const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
      const requestId = parsedRequestBody(options).request_id as string

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await mutation
      })
      expect(result.current.post.poll_bull).toBe(1)

      await act(async () => {
        lateBody.resolve(builtInVoteReceipt(requestId, { poll: { bull: 99, bear: 2, wait: 3 } }))
        await Promise.resolve()
      })
      expect(result.current.post.poll_bull).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('fails empty for A poll state on the first B render', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      return jsonResponse(customPollReadReceipt(requestId))
    })
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: reactionViewer }
    )
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))
    expect(result.current.actions.customPoll?.id).toBe(CUSTOM_POLL_ID)
    expect(result.current.actions.customPollLoadState).toBe('ready')

    rerender({
      accessToken: 'token-b',
      currentUserId: REPOST_OTHER_ACTOR_ID,
      viewerKey: `user:${REPOST_OTHER_ACTOR_ID}`,
      sessionGeneration: 8,
    })

    expect(result.current.actions.customPoll).toBeNull()
    expect(result.current.actions.customPollUserVotes).toEqual([])
    expect(result.current.actions.selectedPollOptions).toEqual([])
    expect(result.current.actions.customPollLoadState).toBe('idle')
  })

  it('does not expose one post poll on the first render of another post for the same viewer', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      return jsonResponse(customPollReadReceipt(requestId))
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))
    expect(result.current.actions.customPoll?.id).toBe(CUSTOM_POLL_ID)

    act(() => {
      result.current.setPost((post) => ({ ...post, id: REPOST_ROOT_POST_ID }))
    })

    expect(result.current.actions.customPoll).toBeNull()
    expect(result.current.actions.customPollUserVotes).toEqual([])
    expect(result.current.actions.selectedPollOptions).toEqual([])
    expect(result.current.actions.customPollLoadState).toBe('idle')
  })

  it('preserves a same-poll snapshot while exposing a later load failure', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      return jsonResponse(customPollReadReceipt(requestId))
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))
    act(() => result.current.actions.setSelectedPollOptions([1]))
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('offline'))
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))

    expect(result.current.actions.customPoll?.id).toBe(CUSTOM_POLL_ID)
    expect(result.current.actions.selectedPollOptions).toEqual([1])
    expect(result.current.actions.customPollLoadState).toBe('error')
    expect(result.current.actions.loadingCustomPoll).toBe(false)
  })

  it('publishes authoritative custom-poll absence as empty instead of an error', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      return jsonResponse(
        customPollReadReceipt(requestId, { action: 'absent', poll: null, user_votes: [] })
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })

    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))

    expect(result.current.actions.customPoll).toBeNull()
    expect(result.current.actions.customPollLoadState).toBe('empty')
  })

  it('drops a late custom-poll snapshot after the viewer generation changes', async () => {
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: reactionViewer }
    )
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    let load!: Promise<void>
    act(() => {
      load = result.current.actions.loadCustomPoll(REACTION_POST_ID)
    })
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
      'request_id'
    ) as string

    rerender({
      accessToken: 'token-b',
      currentUserId: REPOST_OTHER_ACTOR_ID,
      viewerKey: `user:${REPOST_OTHER_ACTOR_ID}`,
      sessionGeneration: 8,
    })
    await act(async () => {
      response.resolve(jsonResponse(customPollReadReceipt(requestId)))
      await load
    })

    expect(result.current.actions.customPoll).toBeNull()
    expect(result.current.actions.customPollLoadState).toBe('idle')
  })

  it('single-flights same-tick custom votes and sends multiple selections in canonical order', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      const receipt = customPollReadReceipt(requestId)
      return jsonResponse({
        ...receipt,
        poll: { ...(receipt.poll as Record<string, unknown>), type: 'multiple' },
      })
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))
    act(() => result.current.actions.setSelectedPollOptions([1, 0]))
    ;(global.fetch as jest.Mock).mockClear()
    ;(global.fetch as jest.Mock).mockImplementation(async (_url: string, options: RequestInit) => {
      const requestBody = parsedRequestBody(options)
      return jsonResponse(
        customPollVoteReceipt(requestBody.request_id as string, {
          option_indexes: [0, 1],
        })
      )
    })

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.actions.submitCustomPollVote(REACTION_POST_ID)
      second = result.current.actions.submitCustomPollVote(REACTION_POST_ID)
    })
    await act(async () => Promise.all([first, second]))

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    expect(parsedRequestBody(options)).toEqual({
      operation: 'set_vote',
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      poll_id: CUSTOM_POLL_ID,
      option_indexes: [0, 1],
    })
    expect(result.current.actions.customPollUserVotes).toEqual([0, 1])
    expect(result.current.actions.customPoll?.totalVotes).toBe(3)
    expect(result.current.actions.votingCustomPoll).toBe(false)
  })

  it('rejects a custom vote receipt for another poll without overwriting the snapshot', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      return jsonResponse(customPollReadReceipt(requestId))
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))
    act(() => result.current.actions.setSelectedPollOptions([0]))
    ;(global.fetch as jest.Mock).mockImplementationOnce(
      async (_url: string, options: RequestInit) => {
        const requestBody = parsedRequestBody(options)
        return jsonResponse(
          customPollVoteReceipt(requestBody.request_id as string, {
            poll_id: OTHER_CUSTOM_POLL_ID,
          })
        )
      }
    )

    await act(async () => result.current.actions.submitCustomPollVote(REACTION_POST_ID))

    expect(result.current.actions.customPollUserVotes).toEqual([])
    expect(result.current.actions.customPoll?.showResults).toBe(false)
    expect(mockShowToast).toHaveBeenLastCalledWith('voteFailed', 'error')
  })

  it('bounds custom-vote JSON parsing and ignores a receipt that arrives after timeout', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const requestId = new URL(url, 'https://www.arenafi.org').searchParams.get(
        'request_id'
      ) as string
      return jsonResponse(customPollReadReceipt(requestId))
    })
    const { result } = renderHook(() => useAliasedPostActions(reactionViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: REACTION_POST_ID }))
    })
    await act(async () => result.current.actions.loadCustomPoll(REACTION_POST_ID))
    act(() => result.current.actions.setSelectedPollOptions([0]))

    jest.useFakeTimers()
    try {
      const lateBody = deferred<unknown>()
      ;(global.fetch as jest.Mock).mockClear()
      ;(global.fetch as jest.Mock).mockResolvedValue(responseWithJson(() => lateBody.promise))
      let mutation!: Promise<void>
      act(() => {
        mutation = result.current.actions.submitCustomPollVote(REACTION_POST_ID)
      })
      await act(async () => Promise.resolve())
      const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
      const requestId = parsedRequestBody(options).request_id as string

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await mutation
      })
      expect(result.current.actions.customPollUserVotes).toEqual([])
      expect(result.current.actions.customPoll?.showResults).toBe(false)
      expect(result.current.actions.votingCustomPoll).toBe(false)

      await act(async () => {
        lateBody.resolve(customPollVoteReceipt(requestId))
        await Promise.resolve()
      })
      expect(result.current.actions.customPollUserVotes).toEqual([])
      expect(result.current.actions.customPoll?.showResults).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('discards a late A bookmark hydration after B becomes active', async () => {
    let resolveBookmarks!: (response: Response) => void
    ;(global.fetch as jest.Mock).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveBookmarks = resolve
      })
    )
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: bookmarkViewer }
    )
    let hydration!: Promise<void>
    act(() => {
      hydration = result.current.actions.loadUserBookmarksAndReposts([BOOKMARK_POST_ID])
    })

    const requestBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[0][1])

    rerender({
      accessToken: 'token-b',
      currentUserId: '44444444-4444-4444-8444-444444444444',
      viewerKey: 'user:44444444-4444-4444-8444-444444444444',
      sessionGeneration: 9,
    })
    await act(async () => {
      resolveBookmarks(jsonResponse(bookmarkStatusReceipt(requestBody.request_id as string)))
      await hydration
    })

    expect(result.current.actions.userBookmarks).toEqual({})
  })

  it('hydrates only an exact viewer-, request-, and post-bound bookmark snapshot', async () => {
    ;(global.fetch as jest.Mock).mockImplementation(async (_url: string, options?: RequestInit) => {
      const body = parsedRequestBody(options)
      return jsonResponse(
        bookmarkStatusReceipt(
          body.request_id as string,
          BOOKMARK_ACTOR_ID,
          body.postIds as string[]
        )
      )
    })
    const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))

    await act(async () => {
      await result.current.actions.loadUserBookmarksAndReposts([BOOKMARK_POST_ID, BOOKMARK_POST_ID])
    })

    expect(result.current.actions.userBookmarks).toEqual({ [BOOKMARK_POST_ID]: true })
    expect(global.fetch).toHaveBeenCalledWith('/api/posts/bookmarks/status', {
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Bearer ${bookmarkViewer.accessToken}`,
        'Content-Type': 'application/json',
      }),
      body: expect.stringMatching(
        new RegExp(`^\\{"postIds":\\["${BOOKMARK_POST_ID}"\\],"request_id":"[0-9a-f]{32}"\\}$`)
      ),
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })

  it('does not let hydration begun during a mutation overwrite its later exact ACK', async () => {
    const mutationResponse = deferred<Response>()
    const hydrationResponse = deferred<Response>()
    ;(global.fetch as jest.Mock)
      .mockReturnValueOnce(mutationResponse.promise)
      .mockReturnValueOnce(hydrationResponse.promise)
    const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
    act(() => {
      result.current.setPost((post) => ({ ...post, id: BOOKMARK_POST_ID }))
      result.current.actions.setBookmarkCounts({ [BOOKMARK_POST_ID]: 3 })
      result.current.actions.setUserBookmarks({ [BOOKMARK_POST_ID]: false })
    })

    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.actions.handleBookmark(BOOKMARK_POST_ID)
    })
    let hydration!: Promise<void>
    act(() => {
      hydration = result.current.actions.loadUserBookmarksAndReposts([BOOKMARK_POST_ID])
    })

    const mutationBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[0][1])
    const hydrationBody = parsedRequestBody((global.fetch as jest.Mock).mock.calls[1][1])
    await act(async () => {
      mutationResponse.resolve(jsonResponse(bookmarkReceipt(mutationBody.request_id as string)))
      await mutation
    })
    expect(result.current.actions.userBookmarks[BOOKMARK_POST_ID]).toBe(true)

    await act(async () => {
      hydrationResponse.resolve(
        jsonResponse(
          bookmarkStatusReceipt(
            hydrationBody.request_id as string,
            BOOKMARK_ACTOR_ID,
            [BOOKMARK_POST_ID],
            { bookmarks: { [BOOKMARK_POST_ID]: false } }
          )
        )
      )
      await hydration
    })

    expect(result.current.actions.userBookmarks[BOOKMARK_POST_ID]).toBe(true)
    expect(result.current.post.bookmark_count).toBe(4)
  })

  it('does not let a malformed fake-empty snapshot clear known bookmark truth', async () => {
    ;(global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ bookmarks: {} }))
    const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))
    act(() => result.current.actions.setUserBookmarks({ [BOOKMARK_POST_ID]: true }))

    await act(async () => {
      await result.current.actions.loadUserBookmarksAndReposts([BOOKMARK_POST_ID])
    })

    expect(result.current.actions.userBookmarks).toEqual({ [BOOKMARK_POST_ID]: true })
  })

  it('times out bookmark hydration, unlocks retry, and ignores the late snapshot', async () => {
    jest.useFakeTimers()
    try {
      const firstResponse = deferred<Response>()
      const lateJson = jest.fn(async () => ({ bookmarks: { [BOOKMARK_POST_ID]: false } }))
      ;(global.fetch as jest.Mock)
        .mockReturnValueOnce(firstResponse.promise)
        .mockImplementationOnce(async (_url: string, options?: RequestInit) => {
          const body = parsedRequestBody(options)
          return jsonResponse(
            bookmarkStatusReceipt(
              body.request_id as string,
              BOOKMARK_ACTOR_ID,
              body.postIds as string[]
            )
          )
        })
      const { result } = renderHook(() => useAliasedPostActions(bookmarkViewer))

      let first!: Promise<void>
      act(() => {
        first = result.current.actions.loadUserBookmarksAndReposts([BOOKMARK_POST_ID])
      })
      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await first
      })

      await act(async () => {
        await result.current.actions.loadUserBookmarksAndReposts([BOOKMARK_POST_ID])
      })
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(result.current.actions.userBookmarks).toEqual({ [BOOKMARK_POST_ID]: true })

      await act(async () => {
        firstResponse.resolve(responseWithJson(lateJson))
        await Promise.resolve()
      })
      expect(lateJson).not.toHaveBeenCalled()
      expect(result.current.actions.userBookmarks).toEqual({ [BOOKMARK_POST_ID]: true })
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects an A-rendered action callback and masks A interaction state on B first render', async () => {
    const { result, rerender } = renderHook(
      (viewer: ViewerProps) => useAliasedPostActions(viewer),
      { initialProps: viewerA }
    )
    act(() => {
      result.current.actions.setShowRepostModal('post-1')
      result.current.actions.setShowBookmarkModal(true)
      result.current.actions.setBookmarkingPostId('post-1')
      result.current.actions.setUserBookmarks({ 'post-1': true })
      result.current.actions.setEditingPost(initialPost)
      result.current.actions.setEditTitle('A private edit title')
    })
    const oldToggleReaction = result.current.actions.toggleReaction

    rerender({
      accessToken: 'token-b',
      currentUserId: 'viewer-b',
      viewerKey: 'user:viewer-b',
      sessionGeneration: 2,
    })

    expect(result.current.actions.showRepostModal).toBeNull()
    expect(result.current.actions.showBookmarkModal).toBe(false)
    expect(result.current.actions.bookmarkingPostId).toBeNull()
    expect(result.current.actions.userBookmarks).toEqual({})
    expect(result.current.actions.editingPost).toBeNull()
    expect(result.current.actions.editTitle).toBe('')

    await act(async () => oldToggleReaction('post-1', 'up'))

    expect(global.fetch).not.toHaveBeenCalled()
    expect(result.current.post.user_reaction).toBeNull()

    act(() => {
      result.current.actions.setUserBookmarks((previous) => ({
        ...previous,
        'post-b': true,
      }))
    })
    expect(result.current.actions.userBookmarks).toEqual({ 'post-b': true })
  })

  it('queues the exact bookmark target when an anonymous viewer clicks bookmark', async () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}?from=hot`)
    const anonymousViewer: ViewerProps = {
      accessToken: null,
      currentUserId: null,
      viewerKey: 'anon',
      sessionGeneration: 0,
    }
    const { result } = renderHook(() => useAliasedPostActions(anonymousViewer))

    await act(async () => {
      await result.current.actions.handleBookmark(postId)
    })

    expect(mockRouterPush).toHaveBeenCalledTimes(1)
    const loginUrl = new URL(mockRouterPush.mock.calls[0][0], 'https://arena.invalid')
    expect(loginUrl.pathname).toBe('/login')
    expect(loginUrl.searchParams.get('returnUrl')).toBe(
      `/post/${postId}?from=hot&resumeAction=bookmark-post`
    )
    expect(window.sessionStorage).toHaveLength(1)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('single-flights an edit and applies only the exact authoritative post', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111'
    const postId = '22222222-2222-4222-8222-222222222222'
    const viewer: ViewerProps = {
      accessToken: 'token-a',
      currentUserId: actorId,
      viewerKey: `user:${actorId}`,
      sessionGeneration: 1,
    }
    const response = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValue(response.promise)
    const { result } = renderHook(() => useAliasedPostActions(viewer))

    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: postId,
        author_id: actorId,
        content_version: 7,
        updated_at: '2026-07-30T01:00:00.000Z',
      }))
    })
    act(() => {
      result.current.actions.setEditingPost(result.current.post)
      result.current.actions.setEditTitle('Submitted title')
      result.current.actions.setEditContent('Submitted body')
    })

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.actions.handleSaveEdit()
      duplicate = result.current.actions.handleSaveEdit()
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/posts/${postId}/edit`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          title: 'Submitted title',
          content: 'Submitted body',
          expected_version: 7,
        }),
      })
    )

    const acknowledgedPost = {
      id: postId,
      author_id: actorId,
      group_id: null,
      title: 'Authoritative title',
      content: 'Authoritative body',
      images: null,
      language: 'en',
      mentions: [],
      hashtags: [],
      content_version: 8,
      updated_at: '2026-07-30T01:35:00.000Z',
    }
    await act(async () => {
      response.resolve(jsonResponse({ success: true, post: acknowledgedPost }))
      await Promise.all([first, duplicate])
    })

    expect(result.current.post).toMatchObject({
      id: acknowledgedPost.id,
      author_id: acknowledgedPost.author_id,
      title: acknowledgedPost.title,
      content: acknowledgedPost.content,
      images: acknowledgedPost.images,
      language: acknowledgedPost.language,
      mentions: acknowledgedPost.mentions,
      hashtags: acknowledgedPost.hashtags,
      content_version: acknowledgedPost.content_version,
      updated_at: acknowledgedPost.updated_at,
    })
    expect(result.current.actions.editingPost).toBeNull()
    expect(mockShowToast).toHaveBeenCalledWith('editSaved', 'success')
  })

  it('preserves the editor and post when a 200 edit acknowledgement is malformed', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111'
    const postId = '22222222-2222-4222-8222-222222222222'
    const viewer: ViewerProps = {
      accessToken: 'token-a',
      currentUserId: actorId,
      viewerKey: `user:${actorId}`,
      sessionGeneration: 1,
    }
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({
        success: true,
        post: {
          id: postId,
          author_id: actorId,
          group_id: null,
          title: 'Untrusted title',
          content: 'Untrusted body',
          images: null,
          content_version: 8,
          updated_at: '2026-07-30T01:35:00.000Z',
          extra: true,
        },
      })
    )
    const { result } = renderHook(() => useAliasedPostActions(viewer))
    act(() => {
      result.current.setPost((post) => ({
        ...post,
        id: postId,
        author_id: actorId,
        content_version: 7,
      }))
    })
    act(() => {
      result.current.actions.setEditingPost(result.current.post)
      result.current.actions.setEditTitle('Submitted title')
      result.current.actions.setEditContent('Submitted body')
    })

    await act(async () => {
      await result.current.actions.handleSaveEdit()
    })

    expect(result.current.post.title).toBe('Post')
    expect(result.current.actions.editingPost?.id).toBe(postId)
    expect(mockShowToast).toHaveBeenCalledWith('editFailed', 'error')
  })

  it('resumes one exact same-tab bookmark after login', async () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}?from=hot`)
    const href = queueProfileActionLogin({
      action: 'bookmark-post',
      target: bookmarkPostTarget(postId),
      fallbackPath: `/post/${postId}`,
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    ;(global.fetch as jest.Mock).mockImplementation(async (_url: string, options?: RequestInit) => {
      const body = parsedRequestBody(options)
      return jsonResponse(
        bookmarkReceipt(body.request_id as string, {
          bookmark_count: 1,
        })
      )
    })

    renderHook(() => useAliasedPostActions(bookmarkViewer))

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(`/api/posts/${postId}/bookmark`, {
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${bookmarkViewer.accessToken}`,
          'Content-Type': 'application/json',
        }),
        body: expect.stringMatching(/^\{"operation":"toggle","request_id":"[0-9a-f]{32}"\}$/),
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      })
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(`${window.location.pathname}${window.location.search}`).toBe(`/post/${postId}?from=hot`)
    expect(window.sessionStorage).toHaveLength(0)
  })

  it('never writes a bookmark from a URL marker without same-tab proof', async () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}?resumeAction=bookmark-post`)

    renderHook(() => useAliasedPostActions())

    await act(async () => {})
    expect(global.fetch).not.toHaveBeenCalled()
    expect(window.sessionStorage).toHaveLength(0)
  })

  it('preserves an authenticated bookmark target when the API session expires', async () => {
    const postId = '22222222-2222-4222-8222-222222222222'
    window.history.replaceState({}, '', `/post/${postId}`)
    ;(global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ error: 'Session expired' }, false, 401)
    )
    const { result } = renderHook(() => useAliasedPostActions())

    await act(async () => {
      await result.current.actions.handleBookmark(postId)
    })

    expect(mockRouterPush).toHaveBeenCalledTimes(1)
    const loginUrl = new URL(mockRouterPush.mock.calls[0][0], 'https://arena.invalid')
    expect(loginUrl.searchParams.get('returnUrl')).toBe(
      `/post/${postId}?resumeAction=bookmark-post`
    )
    expect(window.sessionStorage).toHaveLength(1)
  })
})
