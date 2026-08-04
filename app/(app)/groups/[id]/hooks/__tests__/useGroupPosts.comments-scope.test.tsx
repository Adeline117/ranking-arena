import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetchPostCommentsPage = jest.fn()
const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: { from: (...args: unknown[]) => mockSupabaseFrom(...args) },
}))
jest.mock('@/lib/api/client', () => ({
  authedFetch: jest.fn(),
  getCsrfHeaders: () => ({}),
}))
jest.mock('@/lib/api/comments-client', () => {
  const actual = jest.requireActual('@/lib/api/comments-client')
  return {
    ...actual,
    fetchPostCommentsPage: (...args: unknown[]) => mockFetchPostCommentsPage(...args),
  }
})
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }))

import { useGroupPosts, type CommentWithAuthor } from '../useGroupPosts'
import { authedFetch } from '@/lib/api/client'

const mockAuthedFetch = authedFetch as jest.Mock
const BOOKMARK_ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const BOOKMARK_POST_ID = '22222222-2222-4222-8222-222222222222'
const BOOKMARK_GROUP_ID = '33333333-3333-4333-8333-333333333333'
const BOOKMARK_FOLDER_ID = '44444444-4444-4444-8444-444444444444'
const REACTION_ACTOR_ID = '55555555-5555-4555-8555-555555555555'
const REACTION_OTHER_ACTOR_ID = '66666666-6666-4666-8666-666666666666'
const REACTION_POST_ID = '77777777-7777-4777-8777-777777777777'
const REACTION_GROUP_ID = '88888888-8888-4888-8888-888888888888'
const REACTION_TIMESTAMP = '2026-08-03T20:30:00.000Z'

type Props = {
  userId: string | null
  accessToken: string | null
  authChecked: boolean
  viewerKey: string
  sessionGeneration: number
  isMember: boolean
  groupVisibility: 'open' | 'apply' | null
  audienceResolved: boolean
}

const baseProps: Props = {
  userId: null,
  accessToken: null,
  authChecked: true,
  viewerKey: 'anon',
  sessionGeneration: 1,
  isMember: false,
  groupVisibility: 'open',
  audienceResolved: true,
}

const comment = (id: string, userId: string): CommentWithAuthor => ({
  id,
  post_id: 'post-1',
  user_id: userId,
  content: id,
  like_count: 0,
  dislike_count: 0,
  created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:00.000Z',
})

function page(comments: CommentWithAuthor[]) {
  return { ok: true, status: 200, comments, commentCount: comments.length, hasMore: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function bookmarkReceipt(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    actor_id: BOOKMARK_ACTOR_ID,
    post_id: BOOKMARK_POST_ID,
    request_id: requestId,
    operation: 'toggle',
    action: 'added',
    bookmarked: true,
    bookmark_count: 6,
    folder_id: BOOKMARK_FOLDER_ID,
    ...overrides,
  }
}

function bookmarkStatusReceipt(requestId: string, bookmarked = true) {
  return {
    actor_id: BOOKMARK_ACTOR_ID,
    request_id: requestId,
    operation: 'status',
    post_ids: [BOOKMARK_POST_ID],
    bookmarks: { [BOOKMARK_POST_ID]: bookmarked },
  }
}

function reactionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      actor_id: REACTION_ACTOR_ID,
      post_id: REACTION_POST_ID,
      requested_reaction: 'up',
      action: 'added',
      reaction: 'up',
      like_count: 6,
      dislike_count: 2,
      ...overrides,
    },
    meta: { timestamp: REACTION_TIMESTAMP },
  }
}

function postsQuery(response: Promise<{ data: unknown[] | null; error: unknown }>) {
  const query: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'in', 'is', 'order', 'limit', 'lt']) {
    query[method] = jest.fn(() => query)
  }
  query.then = (resolve: unknown, reject: unknown) =>
    response.then(
      resolve as (value: { data: unknown[] | null; error: unknown }) => unknown,
      reject as (reason: unknown) => unknown
    )
  return query
}

function renderGroupHook(
  initialProps: Props,
  onRender?: (comments: Record<string, CommentWithAuthor[]>) => void,
  showToast = jest.fn(),
  groupId = 'group-1'
) {
  return renderHook(
    (props: Props) => {
      const value = useGroupPosts({
        groupId,
        ...props,
        language: 'en',
        t: (key) => key,
        showToast,
        showDangerConfirm: async () => true,
      })
      onRender?.(value.comments)
      return value
    },
    { initialProps }
  )
}

describe('useGroupPosts comment audience and viewer scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('stops a posts request at unmount before enrichment, state, or toast work', async () => {
    const postsResponse = deferred<{ data: unknown[]; error: null }>()
    mockSupabaseFrom.mockReturnValue(postsQuery(postsResponse.promise))
    const showToast = jest.fn()
    const { result, unmount } = renderGroupHook(baseProps, undefined, showToast)
    let request!: Promise<void>

    act(() => {
      request = result.current.loadPosts()
    })
    expect(mockSupabaseFrom).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => {
      postsResponse.resolve({
        data: [
          {
            id: 'late-post',
            group_id: 'group-1',
            title: 'late',
            created_at: '2026-07-16T00:00:00.000Z',
            author_id: 'late-author',
          },
        ],
        error: null,
      })
      await request
    })

    expect(mockSupabaseFrom).toHaveBeenCalledTimes(1)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('does not toast an older posts failure after a newer request owns the slot', async () => {
    const older = deferred<{ data: null; error: Error }>()
    const newer = deferred<{ data: unknown[]; error: null }>()
    mockSupabaseFrom
      .mockReturnValueOnce(postsQuery(older.promise))
      .mockReturnValueOnce(postsQuery(newer.promise))
    const showToast = jest.fn()
    const { result } = renderGroupHook(baseProps, undefined, showToast)
    let olderRequest!: Promise<void>
    let newerRequest!: Promise<void>

    act(() => {
      olderRequest = result.current.loadPosts()
      newerRequest = result.current.loadPosts()
    })
    await act(async () => {
      newer.resolve({ data: [], error: null })
      await newerRequest
    })
    await act(async () => {
      older.resolve({ data: null, error: new Error('superseded failure') })
      await olderRequest
    })

    expect(showToast).not.toHaveBeenCalled()
    expect(result.current.posts).toEqual([])
  })

  it('does not publish fake unbookmarked group posts when bookmark hydration fails', async () => {
    const post = {
      id: BOOKMARK_POST_ID,
      group_id: BOOKMARK_GROUP_ID,
      title: 'Post',
      created_at: '2026-07-15T00:00:00.000Z',
      bookmark_count: 5,
    }
    let postsTableCalls = 0
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'posts') {
        postsTableCalls += 1
        return postsQuery(
          Promise.resolve({ data: postsTableCalls === 1 ? [post] : [], error: null })
        )
      }
      if (table === 'post_bookmarks') {
        return postsQuery(Promise.resolve({ data: null, error: new Error('bookmark read failed') }))
      }
      if (table === 'post_likes' || table === 'user_profiles') {
        return postsQuery(Promise.resolve({ data: [], error: null }))
      }
      throw new Error(`unexpected table ${table}`)
    })
    const showToast = jest.fn()
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: BOOKMARK_ACTOR_ID,
      viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
      isMember: true,
    }
    const { result } = renderGroupHook(props, undefined, showToast, BOOKMARK_GROUP_ID)

    await act(async () => result.current.loadPosts())

    expect(result.current.posts).toEqual([])
    expect(showToast).toHaveBeenCalledWith('loadBookmarksFailed', 'error')
  })

  it('loads an open group thread anonymously after auth and audience resolve', async () => {
    mockFetchPostCommentsPage.mockResolvedValue(page([comment('anon-comment', 'author')]))
    const { result } = renderGroupHook(baseProps)

    act(() => result.current.toggleComments('post-1'))
    await waitFor(() => expect(result.current.comments['post-1']).toHaveLength(1))

    expect(mockFetchPostCommentsPage).toHaveBeenCalledWith('post-1', null, {
      viewerScope: { expectedUserId: null, expectedSessionGeneration: 1 },
    })
  })

  it('does not issue or cache an apply-group read for a nonmember', async () => {
    const { result } = renderGroupHook({
      ...baseProps,
      groupVisibility: 'apply',
      accessToken: 'token-outsider',
      userId: 'outsider',
      viewerKey: 'user:outsider',
    })

    act(() => result.current.toggleComments('post-1'))
    await act(async () => Promise.resolve())

    expect(mockFetchPostCommentsPage).not.toHaveBeenCalled()
    expect(result.current.comments['post-1']).toBeUndefined()
  })

  it('loads an apply-group thread for an authenticated member', async () => {
    mockFetchPostCommentsPage.mockResolvedValue(page([comment('member-comment', 'member-a')]))
    const props = {
      ...baseProps,
      groupVisibility: 'apply' as const,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    const { result } = renderGroupHook(props)

    act(() => result.current.toggleComments('post-1'))
    await waitFor(() => expect(result.current.comments['post-1']).toHaveLength(1))

    expect(mockFetchPostCommentsPage).toHaveBeenCalledWith('post-1', 'token-a', {
      viewerScope: { expectedUserId: 'user-a', expectedSessionGeneration: 1 },
    })
  })

  it('reloads the same expanded thread for B and discards the late A response', async () => {
    const requests = new Map<string, (value: unknown) => void>()
    const renderSnapshots: string[][] = []
    mockFetchPostCommentsPage.mockImplementation(
      (_postId: string, token: string) =>
        new Promise((resolve) => {
          requests.set(token, resolve)
        })
    )
    const userA = {
      ...baseProps,
      groupVisibility: 'apply' as const,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    const { result, rerender } = renderGroupHook(userA, (comments) => {
      renderSnapshots.push((comments['post-1'] || []).map((item) => item.id))
    })
    act(() => result.current.toggleComments('post-1'))
    await waitFor(() => expect(requests.has('token-a')).toBe(true))

    const firstBRender = renderSnapshots.length
    rerender({
      ...userA,
      accessToken: 'token-b',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    await waitFor(() => expect(requests.has('token-b')).toBe(true))
    expect(
      renderSnapshots.slice(firstBRender).every((commentIds) => !commentIds.includes('comment-a'))
    ).toBe(true)

    await act(async () => {
      requests.get('token-b')?.(page([comment('comment-b', 'user-b')]))
      await Promise.resolve()
    })
    await act(async () => {
      requests.get('token-a')?.(page([comment('comment-a', 'user-a')]))
      await Promise.resolve()
    })

    expect(result.current.comments['post-1'].map((item) => item.id)).toEqual(['comment-b'])
  })

  it('fails empty on the first B render before the cleanup effect runs', async () => {
    const userA = {
      ...baseProps,
      groupVisibility: 'apply' as const,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    let resolveB!: (value: unknown) => void
    mockFetchPostCommentsPage
      .mockResolvedValueOnce(page([comment('a-private', 'user-a')]))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveB = resolve
        })
      )
    const renderSnapshots: string[][] = []
    const { result, rerender } = renderGroupHook(userA, (comments) => {
      renderSnapshots.push((comments['post-1'] || []).map((item) => item.id))
    })
    act(() => result.current.toggleComments('post-1'))
    await waitFor(() => expect(result.current.comments['post-1']?.[0]?.id).toBe('a-private'))

    const firstBRender = renderSnapshots.length
    rerender({
      ...userA,
      accessToken: 'token-b',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    await waitFor(() => expect(mockFetchPostCommentsPage).toHaveBeenCalledTimes(2))

    expect(
      renderSnapshots.slice(firstBRender).every((commentIds) => !commentIds.includes('a-private'))
    ).toBe(true)
    await act(async () => {
      resolveB(page([]))
      await Promise.resolve()
    })
  })

  it('accepts a sanitized actor-bound ACK and clears only its captured draft version', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    const acknowledgement = {
      ...comment('comment-a', 'user-a'),
      content: 'hello',
      parent_id: null,
    }
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 201,
      data: { success: true, data: { comment: acknowledgement } },
    })
    mockFetchPostCommentsPage.mockResolvedValue(page([acknowledgement]))
    const { result } = renderGroupHook(props)
    act(() => result.current.setNewComment({ 'post-1': '<b>hello</b>' }))

    await act(async () => result.current.submitComment('post-1'))

    expect(result.current.newComment['post-1']).toBe('')
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/posts/post-1/comments',
      'POST',
      'token-a',
      { content: '<b>hello</b>' },
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: 1 }
    )
  })

  it('does not clear an equal-text draft that was edited while its ACK was in flight', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    let resolveSubmit!: (value: unknown) => void
    mockAuthedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
    )
    const acknowledgement = {
      ...comment('comment-a', 'user-a'),
      content: 'same text',
      parent_id: null,
    }
    mockFetchPostCommentsPage.mockResolvedValue(page([acknowledgement]))
    const { result } = renderGroupHook(props)
    act(() => result.current.setNewComment({ 'post-1': 'same text' }))
    let submission!: Promise<void>
    act(() => {
      submission = result.current.submitComment('post-1')
    })
    act(() => result.current.setNewComment({ 'post-1': 'different text' }))
    act(() => result.current.setNewComment({ 'post-1': 'same text' }))

    await act(async () => {
      resolveSubmit({
        ok: true,
        status: 201,
        data: { success: true, data: { comment: acknowledgement } },
      })
      await submission
    })

    expect(result.current.newComment['post-1']).toBe('same text')
  })

  it('drops an A interaction response after B becomes the active viewer', async () => {
    const userA = {
      ...baseProps,
      accessToken: 'token-a',
      userId: REACTION_ACTOR_ID,
      viewerKey: `user:${REACTION_ACTOR_ID}`,
      isMember: true,
    }
    const requestA = deferred<unknown>()
    mockAuthedFetch.mockReturnValueOnce(requestA.promise)
    const { result, rerender } = renderGroupHook(userA, undefined, jest.fn(), REACTION_GROUP_ID)

    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.handleLike(REACTION_POST_ID)
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/posts/${REACTION_POST_ID}/like`,
      'POST',
      'token-a',
      { reaction_type: 'up' },
      15_000,
      { expectedUserId: REACTION_ACTOR_ID, expectedSessionGeneration: 1 }
    )

    rerender({
      ...userA,
      accessToken: 'token-b',
      userId: REACTION_OTHER_ACTOR_ID,
      viewerKey: `user:${REACTION_OTHER_ACTOR_ID}`,
      sessionGeneration: 2,
    })
    expect(result.current.likeLoading).toEqual({})
    act(() => {
      result.current.setPosts([
        {
          id: REACTION_POST_ID,
          group_id: REACTION_GROUP_ID,
          title: 'B post',
          created_at: '2026-07-15T00:00:00.000Z',
          like_count: 50,
          dislike_count: 4,
          user_liked: false,
          user_reaction: 'down',
        },
      ])
    })

    await act(async () => {
      requestA.resolve({ ok: true, status: 200, data: reactionReceipt() })
      await mutation
    })

    expect(result.current.likeLoading).toEqual({})
    expect(result.current.posts[0]).toMatchObject({
      title: 'B post',
      like_count: 50,
      dislike_count: 4,
      user_reaction: 'down',
    })
  })

  it('locks same-frame likes and adopts only the server reaction ACK', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: REACTION_ACTOR_ID,
      viewerKey: `user:${REACTION_ACTOR_ID}`,
      isMember: true,
    }
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const { result } = renderGroupHook(props, undefined, jest.fn(), REACTION_GROUP_ID)
    act(() => {
      result.current.setPosts([
        {
          id: REACTION_POST_ID,
          group_id: REACTION_GROUP_ID,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          like_count: 5,
          dislike_count: 2,
          user_liked: false,
          user_reaction: null,
        },
      ])
    })

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.handleLike(REACTION_POST_ID)
      duplicate = result.current.handleLike(REACTION_POST_ID)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(result.current.likeLoading[REACTION_POST_ID]).toBe(true)

    await act(async () => {
      request.resolve({
        ok: true,
        status: 200,
        data: reactionReceipt({ dislike_count: 3 }),
      })
      await Promise.all([first, duplicate])
    })

    expect(result.current.posts[0]).toMatchObject({
      like_count: 6,
      dislike_count: 3,
      user_liked: true,
      user_reaction: 'up',
    })
    expect(result.current.likeLoading[REACTION_POST_ID]).toBe(false)
  })

  it('single-flights group bookmarks and adopts only the exact bound receipt', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: BOOKMARK_ACTOR_ID,
      viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
      isMember: true,
    }
    const response = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const { result } = renderGroupHook(props, undefined, jest.fn(), BOOKMARK_GROUP_ID)
    act(() => {
      result.current.setPosts([
        {
          id: BOOKMARK_POST_ID,
          group_id: BOOKMARK_GROUP_ID,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          bookmark_count: 5,
          user_bookmarked: false,
        },
      ])
    })

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.handleBookmark(BOOKMARK_POST_ID)
      duplicate = result.current.handleBookmark(BOOKMARK_POST_ID)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    const requestBody = mockAuthedFetch.mock.calls[0][3] as Record<string, unknown>
    expect(requestBody).toEqual({
      operation: 'toggle',
      request_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/posts/${BOOKMARK_POST_ID}/bookmark`,
      'POST',
      'token-a',
      requestBody,
      15_000,
      { expectedUserId: BOOKMARK_ACTOR_ID, expectedSessionGeneration: 1 }
    )
    expect(result.current.bookmarkLoading[BOOKMARK_POST_ID]).toBe(true)

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: bookmarkReceipt(requestBody.request_id as string),
      })
      await Promise.all([first, duplicate])
    })

    expect(result.current.posts[0]).toMatchObject({
      user_bookmarked: true,
      bookmark_count: 6,
    })
    expect(result.current.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
  })

  it.each([
    ['another actor', { actor_id: BOOKMARK_GROUP_ID }],
    ['another post', { post_id: BOOKMARK_GROUP_ID }],
    ['another request', { request_id: 'b'.repeat(32) }],
    ['an extra field', { invented: true }],
  ])(
    'rejects a group bookmark receipt bound to %s and unlocks retry',
    async (_label, overrides) => {
      const props = {
        ...baseProps,
        accessToken: 'token-a',
        userId: BOOKMARK_ACTOR_ID,
        viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
        isMember: true,
      }
      mockAuthedFetch.mockImplementation(
        async (_url, _method, _token, body: Record<string, unknown>) => ({
          ok: true,
          status: 200,
          data: bookmarkReceipt(body.request_id as string, overrides as Record<string, unknown>),
        })
      )
      const showToast = jest.fn()
      const { result } = renderGroupHook(props, undefined, showToast, BOOKMARK_GROUP_ID)
      act(() => {
        result.current.setPosts([
          {
            id: BOOKMARK_POST_ID,
            group_id: BOOKMARK_GROUP_ID,
            title: 'Post',
            created_at: '2026-07-15T00:00:00.000Z',
            bookmark_count: 5,
            user_bookmarked: false,
          },
        ])
      })

      await act(async () => result.current.handleBookmark(BOOKMARK_POST_ID))

      expect(result.current.posts[0]).toMatchObject({
        user_bookmarked: false,
        bookmark_count: 5,
      })
      expect(result.current.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
      expect(showToast).toHaveBeenCalledWith('operationFailed', 'error')
    }
  )

  it('converges a timed-out group bookmark from its exact status snapshot', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: BOOKMARK_ACTOR_ID,
      viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
      isMember: true,
    }
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: false, status: 0, data: null })
      .mockImplementationOnce(async (_url, _method, _token, body: Record<string, unknown>) => ({
        ok: true,
        status: 200,
        data: bookmarkStatusReceipt(body.request_id as string),
      }))
    const showToast = jest.fn()
    const { result } = renderGroupHook(props, undefined, showToast, BOOKMARK_GROUP_ID)
    act(() => {
      result.current.setPosts([
        {
          id: BOOKMARK_POST_ID,
          group_id: BOOKMARK_GROUP_ID,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          bookmark_count: 5,
          user_bookmarked: false,
        },
      ])
    })

    await act(async () => result.current.handleBookmark(BOOKMARK_POST_ID))
    expect(result.current.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(result.current.posts[0]).toMatchObject({ user_bookmarked: true, bookmark_count: 6 })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('unlocks a group bookmark retry when mutation and status reads both fail', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: BOOKMARK_ACTOR_ID,
      viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
      isMember: true,
    }
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: false, status: 0, data: null })
      .mockResolvedValueOnce({ ok: false, status: 500, data: null })
      .mockImplementationOnce(async (_url, _method, _token, body: Record<string, unknown>) => ({
        ok: true,
        status: 200,
        data: bookmarkReceipt(body.request_id as string),
      }))
    const showToast = jest.fn()
    const { result } = renderGroupHook(props, undefined, showToast, BOOKMARK_GROUP_ID)
    act(() => {
      result.current.setPosts([
        {
          id: BOOKMARK_POST_ID,
          group_id: BOOKMARK_GROUP_ID,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          bookmark_count: 5,
          user_bookmarked: false,
        },
      ])
    })

    await act(async () => result.current.handleBookmark(BOOKMARK_POST_ID))
    expect(result.current.bookmarkLoading[BOOKMARK_POST_ID]).toBe(false)
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')
    expect(result.current.posts[0]).toMatchObject({ user_bookmarked: false, bookmark_count: 5 })

    await act(async () => result.current.handleBookmark(BOOKMARK_POST_ID))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(3)
    expect(result.current.posts[0]).toMatchObject({ user_bookmarked: true, bookmark_count: 6 })
  })

  it('drops a late group bookmark receipt after the viewer scope changes', async () => {
    const userA = {
      ...baseProps,
      accessToken: 'token-a',
      userId: BOOKMARK_ACTOR_ID,
      viewerKey: `user:${BOOKMARK_ACTOR_ID}`,
      isMember: true,
    }
    const response = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const { result, rerender } = renderGroupHook(userA, undefined, jest.fn(), BOOKMARK_GROUP_ID)
    act(() => {
      result.current.setPosts([
        {
          id: BOOKMARK_POST_ID,
          group_id: BOOKMARK_GROUP_ID,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          bookmark_count: 5,
          user_bookmarked: false,
        },
      ])
    })
    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.handleBookmark(BOOKMARK_POST_ID)
    })
    const requestBody = mockAuthedFetch.mock.calls[0][3] as Record<string, unknown>

    rerender({
      ...userA,
      accessToken: 'token-b',
      userId: BOOKMARK_GROUP_ID,
      viewerKey: `user:${BOOKMARK_GROUP_ID}`,
      sessionGeneration: 2,
    })
    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: bookmarkReceipt(requestBody.request_id as string),
      })
      await mutation
    })

    expect(result.current.posts).toEqual([])
    expect(result.current.bookmarkLoading).toEqual({})
  })

  it('single-flights one group pin scope and adopts only its explicit desired-state ACK', async () => {
    const groupId = '11111111-1111-4111-8111-111111111111'
    const postId = '22222222-2222-4222-8222-222222222222'
    const authorId = '33333333-3333-4333-8333-333333333333'
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: authorId,
      viewerKey: `user:${authorId}`,
      isMember: true,
    }
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const showToast = jest.fn()
    const { result } = renderGroupHook(props, undefined, showToast, groupId)
    act(() => {
      result.current.setPosts([
        {
          id: postId,
          group_id: groupId,
          author_id: authorId,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          is_pinned: false,
        },
      ])
    })

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.handlePinPost(postId)
      duplicate = result.current.handlePinPost(postId)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      `/api/posts/${postId}/pin`,
      'POST',
      'token-a',
      { is_pinned: true },
      15_000,
      { expectedUserId: authorId, expectedSessionGeneration: 1 }
    )

    await act(async () => {
      request.resolve({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: {
            post_id: postId,
            author_id: authorId,
            group_id: groupId,
            scope_type: 'group',
            scope_id: groupId,
            is_pinned: true,
            already_set: false,
            unpinned_count: 0,
            message: 'Pinned',
          },
        },
      })
      await Promise.all([first, duplicate])
    })

    expect(result.current.posts[0].is_pinned).toBe(true)
    expect(showToast).toHaveBeenCalledWith('pinned', 'success')
  })

  it('single-flights a destructive group post delete', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    const request = deferred<unknown>()
    mockAuthedFetch.mockReturnValue(request.promise)
    const showToast = jest.fn()
    const { result } = renderGroupHook(props, undefined, showToast)
    act(() => {
      result.current.setPosts([
        {
          id: 'post-1',
          group_id: 'group-1',
          author_id: 'user-a',
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
        },
      ])
    })

    let first!: Promise<void>
    let duplicate!: Promise<void>
    act(() => {
      first = result.current.handleDeletePost('post-1')
      duplicate = result.current.handleDeletePost('post-1')
    })

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/posts/post-1/delete',
      'DELETE',
      'token-a',
      undefined,
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: 1 }
    )
    expect(result.current.deletingPost).toBe('post-1')

    await act(async () => {
      request.resolve({ ok: true, status: 200, data: { success: true } })
      await Promise.all([first, duplicate])
    })

    expect(result.current.posts).toEqual([])
    expect(result.current.deletingPost).toBeNull()
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('postDeleted', 'success')
  })

  it('rejects a malformed reaction ACK without changing local state and unlocks retry', async () => {
    const props = {
      ...baseProps,
      accessToken: 'token-a',
      userId: REACTION_ACTOR_ID,
      viewerKey: `user:${REACTION_ACTOR_ID}`,
      isMember: true,
    }
    const showToast = jest.fn()
    mockAuthedFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: reactionReceipt({ actor_id: REACTION_OTHER_ACTOR_ID, like_count: 99 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: reactionReceipt({ dislike_count: 1 }),
      })
    const { result } = renderGroupHook(props, undefined, showToast, REACTION_GROUP_ID)
    act(() => {
      result.current.setPosts([
        {
          id: REACTION_POST_ID,
          group_id: REACTION_GROUP_ID,
          title: 'Post',
          created_at: '2026-07-15T00:00:00.000Z',
          like_count: 5,
          dislike_count: 1,
          user_liked: false,
          user_reaction: null,
        },
      ])
    })

    await act(async () => result.current.handleLike(REACTION_POST_ID))
    expect(result.current.posts[0]).toMatchObject({
      like_count: 5,
      dislike_count: 1,
      user_liked: false,
      user_reaction: null,
    })
    expect(showToast).toHaveBeenCalledWith('operationFailed', 'error')

    await act(async () => result.current.handleLike(REACTION_POST_ID))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
    expect(result.current.posts[0]).toMatchObject({
      like_count: 6,
      dislike_count: 1,
      user_liked: true,
      user_reaction: 'up',
    })
  })
})
