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
    expect(mockSetStoreComments).toHaveBeenCalledTimes(1)
    expect(mockSetStoreComments).toHaveBeenCalledWith('post-b', expect.any(Array))
    expect(result.current.loadingComments).toBe(false)
  })

  it('clears the previous post draft when the next post has no saved draft', () => {
    localStorage.setItem('comment-draft-v2:user:legacy:post-a', 'draft A')
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

    localStorage.setItem('comment-draft-v2:user:legacy:post-b', 'post B draft')
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
    expect(localStorage.getItem('comment-draft-v2:user:legacy:post-a')).toBe('post A failed draft')
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
    act(() => result.current.setNewComment('wait for hydration'))

    await act(async () => result.current.submitComment('post-1'))

    expect(mockOpenLoginModal).not.toHaveBeenCalled()
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(result.current.newComment).toBe('wait for hydration')
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

  it('fails A reply and edit interaction state empty during the first B render', async () => {
    const snapshots: Array<{
      viewerKey: string
      replyContent: string
      replyingTo: string | null
      editingComment: string | null
      editContent: string
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
          replyContent: value.replyContent,
          replyingTo: value.replyingTo?.commentId ?? null,
          editingComment: value.editingComment?.id ?? null,
          editContent: value.editContent,
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
      result.current.setReplyContent('A private reply')
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
      replyContent: '',
      replyingTo: null,
      editingComment: null,
      editContent: '',
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
    act(() => {
      result.current.setNewComment('A create')
      result.current.setReplyContent('A reply')
    })
    const staleCreate = result.current.submitComment
    const staleReply = result.current.submitReply

    await act(async () => result.current.loadComments('post-b'))
    mockAuthedFetch.mockClear()
    onCommentCountChange.mockClear()
    await act(async () => {
      await staleCreate('post-a')
      await staleReply('post-a', parent.id)
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

  it('preserves comments and draft across a same-A token refresh', async () => {
    const comment = makeComment()
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { success: true, data: { comments: [comment], post: { comment_count: 1 } } },
    })
    const { result, rerender } = renderScopedHook(userA)
    await act(async () => result.current.loadComments('post-1'))
    act(() => result.current.setNewComment('A draft'))

    rerender({ ...userA, accessToken: 'token-a2' })

    expect(result.current.comments).toEqual([comment])
    expect(result.current.newComment).toBe('A draft')
  })

  it('ignores an old A mutation ACK after logout', async () => {
    let resolveSubmit!: (value: unknown) => void
    mockAuthedFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = resolve
      })
    )
    const { result, rerender, showToast } = renderScopedHook(userA)
    act(() => result.current.setNewComment('A text'))
    let submission!: Promise<void>
    act(() => {
      submission = result.current.submitComment('post-1')
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
    expect(result.current.newComment).toBe('')
    expect(showToast).not.toHaveBeenCalled()
  })

  it('accepts a sanitized strict ACK and only then clears the draft', async () => {
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
    act(() => result.current.setNewComment('<b>hello</b>'))

    await act(async () => result.current.submitComment('post-1'))

    expect(result.current.newComment).toBe('')
    expect(result.current.comments[0].content).toBe('hello')
  })

  it('does not let a Post A ACK clear an equal-text Post B draft', async () => {
    let resolveSubmit!: (value: unknown) => void
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { success: true, data: { comments: [], post: { comment_count: 0 } } },
        })
      }
      return new Promise((resolve) => {
        resolveSubmit = resolve
      })
    })
    const { result } = renderScopedHook(userA)
    await act(async () => result.current.loadComments('post-a'))
    act(() => result.current.setNewComment('same text'))

    let submission!: Promise<void>
    act(() => {
      submission = result.current.submitComment('post-a')
    })
    await act(async () => result.current.loadComments('post-b'))
    act(() => result.current.setNewComment('same text'))

    await act(async () => {
      resolveSubmit({
        ok: true,
        status: 201,
        data: {
          success: true,
          data: {
            comment: {
              id: 'comment-a',
              post_id: 'post-a',
              user_id: 'user-a',
              content: 'same text',
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

    expect(result.current.newComment).toBe('same text')
  })
})
