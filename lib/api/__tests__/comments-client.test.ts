const mockAuthedFetch = jest.fn()

jest.mock('../client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

import {
  fetchPostCommentsPage,
  isCreatedCommentAcknowledgement,
  isDefinitiveMutationRejection,
} from '../comments-client'

describe('fetchPostCommentsPage', () => {
  beforeEach(() => {
    mockAuthedFetch.mockReset()
  })

  it('forwards auth and strictly parses comments plus the absolute post count', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: {
          comments: [{ id: 'comment-1' }],
          post: { comment_count: 7 },
        },
        meta: { pagination: { has_more: true } },
      },
    })

    const result = await fetchPostCommentsPage<{ id: string }>('post/with space', 'token-1', {
      limit: 10,
      offset: 20,
      sort: 'time',
    })

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/posts/post%2Fwith%20space/comments?limit=10&offset=20&sort=time',
      'GET',
      'token-1'
    )
    expect(result).toEqual({
      ok: true,
      status: 200,
      comments: [{ id: 'comment-1' }],
      commentCount: 7,
      hasMore: true,
    })
  })

  it('keeps anonymous public reads token-free', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        success: true,
        data: { comments: [], post: { comment_count: 0 } },
      },
    })

    await fetchPostCommentsPage('post-1', null)

    expect(mockAuthedFetch).toHaveBeenCalledWith('/api/posts/post-1/comments', 'GET', null)
  })

  it('fails closed on a legacy or malformed response envelope', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { comments: [{ id: 'legacy-comment' }], pagination: { has_more: true } },
    })

    await expect(fetchPostCommentsPage('post-1', 'token-1')).resolves.toEqual({
      ok: false,
      status: 200,
      comments: [],
      commentCount: 0,
      hasMore: false,
      error: undefined,
    })
  })

  it.each([
    { success: true, data: { comments: [] } },
    { success: true, data: { comments: [], post: { comment_count: -1 } } },
    { success: true, data: { comments: [], post: { comment_count: 1.5 } } },
    { success: true, data: { comments: {}, post: { comment_count: 0 } } },
  ])('fails closed on malformed canonical truth: %#', async (data) => {
    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data })

    await expect(fetchPostCommentsPage('post-1', 'token-1')).resolves.toMatchObject({
      ok: false,
      status: 200,
      comments: [],
      commentCount: 0,
    })
  })

  it.each([403, 404])('turns authoritative HTTP %s absence into a clear signal', async (status) => {
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status,
      data: { error: 'Post not found' },
    })

    await expect(fetchPostCommentsPage('post-1', 'token-1')).resolves.toEqual({
      ok: true,
      status,
      comments: [],
      commentCount: 0,
      hasMore: false,
      resourceAbsent: true,
      error: 'Post not found',
    })
  })

  it('keeps a 5xx read unavailable instead of clearing known state', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      data: { error: 'unavailable' },
    })

    await expect(fetchPostCommentsPage('post-1', 'token-1')).resolves.toMatchObject({
      ok: false,
      status: 503,
    })
  })
})

describe('isDefinitiveMutationRejection', () => {
  it('separates explicit 4xx rejection from an unknown commit outcome', () => {
    expect(isDefinitiveMutationRejection({ ok: false, status: 409 })).toBe(true)
    expect(isDefinitiveMutationRejection({ ok: false, status: 429 })).toBe(true)
    expect(isDefinitiveMutationRejection({ ok: false, status: 408 })).toBe(false)
    expect(isDefinitiveMutationRejection({ ok: false, status: 500 })).toBe(false)
    expect(isDefinitiveMutationRejection({ ok: false, status: 0 })).toBe(false)
    expect(isDefinitiveMutationRejection({ ok: true, status: 200 })).toBe(false)
  })
})

describe('isCreatedCommentAcknowledgement', () => {
  const acknowledgement = {
    id: 'comment-1',
    post_id: 'post-1',
    user_id: 'user-1',
    content: 'hello',
    parent_id: null,
    like_count: 0,
    dislike_count: 0,
    created_at: '2026-07-15T20:00:00.000Z',
    updated_at: '2026-07-15T20:00:00.000Z',
  }

  it('binds a valid ACK to the expected post, parent, and actor', () => {
    expect(
      isCreatedCommentAcknowledgement(acknowledgement, {
        postId: 'post-1',
        userId: 'user-1',
      })
    ).toBe(true)

    expect(
      isCreatedCommentAcknowledgement(
        { ...acknowledgement, post_id: 'post-2' },
        { postId: 'post-1' }
      )
    ).toBe(false)
    expect(
      isCreatedCommentAcknowledgement(
        { ...acknowledgement, user_id: 'user-2' },
        { postId: 'post-1', userId: 'user-1' }
      )
    ).toBe(false)

    // The server stores sanitized text, so content identity cannot be proven by
    // comparing the raw input with the returned representation.
    expect(
      isCreatedCommentAcknowledgement(
        { ...acknowledgement, content: 'hello' },
        { postId: 'post-1', userId: 'user-1' }
      )
    ).toBe(true)
  })

  it('rejects malformed counters, timestamps, and reply bindings', () => {
    expect(
      isCreatedCommentAcknowledgement({ ...acknowledgement, like_count: 0.5 }, { postId: 'post-1' })
    ).toBe(false)
    expect(
      isCreatedCommentAcknowledgement(
        { ...acknowledgement, updated_at: 'not-a-date' },
        { postId: 'post-1' }
      )
    ).toBe(false)
    expect(
      isCreatedCommentAcknowledgement(acknowledgement, {
        postId: 'post-1',
        parentId: 'parent-1',
      })
    ).toBe(false)
  })
})
