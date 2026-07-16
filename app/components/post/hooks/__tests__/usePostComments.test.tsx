import { act, renderHook } from '@testing-library/react'
import { usePostComments, type Comment } from '../usePostComments'

const mockAuthedFetch = jest.fn()
const mockSetStoreComments = jest.fn()
const mockAddStoreComment = jest.fn()
const mockUpdatePostCommentCount = jest.fn()
const mockOpenLoginModal = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
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
  } = {}
) {
  const showToast = jest.fn()
  const hook = renderHook(() =>
    usePostComments({
      accessToken: 'token',
      showToast,
      showDangerConfirm: options.showDangerConfirm || (async () => true),
      onCommentCountChange: options.onCommentCountChange,
      t: (key) => key,
    })
  )
  return { ...hook, showToast }
}

function failedResult(status = 500) {
  return Promise.resolve({
    ok: false,
    status,
    data: { success: false, error: 'rejected' },
  })
}

describe('usePostComments reactions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('reads the latest loaded comment state instead of a stale callback closure', async () => {
    mockAuthedFetch.mockImplementation(() => failedResult(409))
    const { result } = renderCommentsHook()
    const loaded = makeComment({ user_liked: true, like_count: 8 })

    act(() => result.current.setComments([loaded]))
    await act(async () => {
      await result.current.toggleCommentLike('post-1', loaded.id)
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: true,
      user_disliked: false,
      like_count: 8,
      dislike_count: 1,
    })
  })

  it('rolls a rejected neutral-to-like toggle back to the exact neutral state', async () => {
    mockAuthedFetch.mockImplementation(() => failedResult(409))
    const { result } = renderCommentsHook()
    act(() => result.current.setComments([makeComment()]))

    await act(async () => {
      await result.current.toggleCommentLike('post-1', 'comment-1')
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
    const { result } = renderCommentsHook()
    act(() =>
      result.current.setComments([
        makeComment({ user_disliked: true, like_count: 2, dislike_count: 4 }),
      ])
    )

    await act(async () => {
      await result.current.toggleCommentLike('post-1', 'comment-1')
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 4,
    })
  })

  it('preserves the uncertain optimistic state when the network and canonical read fail', async () => {
    mockAuthedFetch.mockRejectedValue(new Error('offline'))
    const { result, showToast } = renderCommentsHook()
    act(() => result.current.setComments([makeComment()]))

    await act(async () => {
      await result.current.toggleCommentDislike('post-1', 'comment-1')
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 2,
      dislike_count: 2,
    })
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')
  })

  it('locks same-frame duplicate reaction requests synchronously', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    mockAuthedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const { result } = renderCommentsHook()
    act(() => result.current.setComments([makeComment()]))

    let firstRequest: Promise<void>
    let duplicateRequest: Promise<void>
    act(() => {
      firstRequest = result.current.toggleCommentLike('post-1', 'comment-1')
      duplicateRequest = result.current.toggleCommentLike('post-1', 'comment-1')
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequest?.({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { like_count: 3, dislike_count: 1, liked: true, disliked: false },
        },
      })
      await Promise.all([firstRequest!, duplicateRequest!])
    })
  })

  it('does not roll a newer authoritative state back when it matches the optimistic reaction', async () => {
    let resolveRequest: ((value: unknown) => void) | undefined
    mockAuthedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const { result } = renderCommentsHook()
    act(() => result.current.setComments([makeComment()]))

    let request: Promise<void>
    act(() => {
      request = result.current.toggleCommentLike('post-1', 'comment-1')
    })

    act(() => {
      result.current.setComments([
        makeComment({ user_liked: true, like_count: 20, dislike_count: 4 }),
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
      data: {
        success: true,
        data: { like_count: 12, dislike_count: 5, liked: false, disliked: true },
      },
    })
    const { result } = renderCommentsHook()
    act(() => result.current.setComments([makeComment()]))

    await act(async () => {
      await result.current.toggleCommentDislike('post-1', 'comment-1')
    })

    expect(result.current.comments[0]).toMatchObject({
      user_liked: false,
      user_disliked: true,
      like_count: 12,
      dislike_count: 5,
    })
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
    expect(mockSetStoreComments).toHaveBeenCalledTimes(2)
    expect(mockSetStoreComments).toHaveBeenCalledWith('post-b', expect.any(Array))
    expect(result.current.loadingComments).toBe(false)
  })

  it('clears the previous post draft when the next post has no saved draft', () => {
    localStorage.setItem('comment-draft-post-a', 'draft A')
    const { result } = renderCommentsHook()

    act(() => result.current.restoreDraft('post-a'))
    expect(result.current.newComment).toBe('draft A')

    act(() => result.current.restoreDraft('post-b'))
    expect(result.current.newComment).toBe('')
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

  it('resets reply, edit, and expansion state when switching posts', async () => {
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
      result.current.setReplyContent('reply draft')
      result.current.setExpandedReplies({ [comment.id]: true })
      result.current.startEditComment(comment)
    })

    await act(async () => result.current.loadComments('post-b'))

    expect(result.current.replyingTo).toBeNull()
    expect(result.current.replyContent).toBe('')
    expect(result.current.expandedReplies).toEqual({})
    expect(result.current.editingComment).toBeNull()
    expect(result.current.editContent).toBe('')
  })

  it('does not let an old failed submit overwrite the new post draft or comments', async () => {
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
    act(() => result.current.setNewComment('post A failed draft'))

    let oldSubmit: Promise<void>
    act(() => {
      oldSubmit = result.current.submitComment('post-a')
    })

    localStorage.setItem('comment-draft-post-b', 'post B draft')
    await act(async () => result.current.loadComments('post-b'))
    expect(result.current.comments).toEqual([commentB])
    expect(result.current.newComment).toBe('post B draft')

    await act(async () => {
      resolveOldSubmit?.({
        ok: false,
        status: 409,
        data: { success: false, error: 'rejected' },
      })
      await oldSubmit!
    })

    expect(result.current.comments).toEqual([commentB])
    expect(result.current.newComment).toBe('post B draft')
    expect(localStorage.getItem('comment-draft-post-a')).toBe('post A failed draft')
    expect(onCommentCountChange).toHaveBeenCalledWith('post-a', 1)
    expect(onCommentCountChange).toHaveBeenCalledWith('post-a', -1)
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
