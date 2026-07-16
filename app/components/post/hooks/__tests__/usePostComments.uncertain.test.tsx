import { act, renderHook } from '@testing-library/react'
import { usePostComments, type Comment } from '../usePostComments'

const mockAuthedFetch = jest.fn()
const mockSetStoreComments = jest.fn()
const mockAddStoreComment = jest.fn()
const mockUpdatePostCommentCount = jest.fn()

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
  useLoginModal: { getState: () => ({ openLoginModal: jest.fn() }) },
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-1',
    post_id: 'post-1',
    user_id: 'user-1',
    content: 'hello',
    created_at: '2026-07-15T20:00:00.000Z',
    updated_at: '2026-07-15T20:00:00.000Z',
    like_count: 0,
    dislike_count: 0,
    user_liked: false,
    user_disliked: false,
    ...overrides,
  }
}

function canonical(comments: Comment[], commentCount: number) {
  return {
    ok: true,
    status: 200,
    data: {
      success: true,
      data: { comments, post: { comment_count: commentCount } },
      meta: { pagination: { has_more: false } },
    },
  }
}

function unavailable() {
  return {
    ok: false,
    status: 503,
    data: { success: false, error: 'unavailable' },
  }
}

function editedAcknowledgement(content: string, overrides: Record<string, unknown> = {}) {
  return {
    author_handle: null,
    author_id: null,
    id: 'comment-1',
    post_id: 'post-1',
    user_id: 'user-1',
    content,
    created_at: '2026-07-15T20:00:00.000Z',
    delete_reason: null,
    deleted_at: null,
    deleted_by: null,
    updated_at: '2026-07-15T21:00:00.000Z',
    parent_id: null,
    like_count: 0,
    dislike_count: 0,
    ranking_score: 0,
    ...overrides,
  }
}

function renderCommentsHook(showDangerConfirm = async () => true) {
  const onCommentCountChange = jest.fn()
  const showToast = jest.fn()
  const hook = renderHook(() =>
    usePostComments({
      accessToken: 'token-1',
      showToast,
      showDangerConfirm,
      onCommentCountChange,
      t: (key) => key,
    })
  )
  return { ...hook, onCommentCountChange, showToast }
}

async function loadInitial(
  result: ReturnType<typeof renderCommentsHook>['result'],
  comments: Comment[],
  count: number,
  postId = 'post-1'
) {
  mockAuthedFetch.mockResolvedValueOnce(canonical(comments, count))
  await act(async () => result.current.loadComments(postId))
}

describe('usePostComments uncertain create/reply/reaction reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('does not undo a committed comment when Realtime arrives before the response is lost', async () => {
    const { result, onCommentCountChange } = renderCommentsHook()
    await loadInitial(result, [], 5)

    let rejectMutation: ((error: Error) => void) | undefined
    mockAuthedFetch.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMutation = reject
      })
    )
    const serverComment = comment({ id: 'server-comment' })
    mockAuthedFetch.mockResolvedValueOnce(canonical([serverComment], 6))

    let request: Promise<boolean>
    act(() => {
      request = result.current.submitComment('post-1', 'hello')
    })

    act(() => result.current.setComments([serverComment]))
    await act(async () => {
      rejectMutation?.(new Error('response lost'))
      await request!
    })

    expect(result.current.comments).toEqual([serverComment])
    expect(onCommentCountChange).toHaveBeenLastCalledWith('post-1', 0, 6)
    expect(onCommentCountChange).not.toHaveBeenCalledWith('post-1', -1)
  })

  it('removes an optimistic comment when canonical GET proves no commit', async () => {
    const { result, onCommentCountChange } = renderCommentsHook()
    await loadInitial(result, [], 3)
    mockAuthedFetch.mockRejectedValueOnce(new Error('offline'))
    mockAuthedFetch.mockResolvedValueOnce(canonical([], 3))

    await act(async () => result.current.submitComment('post-1', 'not committed'))

    expect(result.current.comments).toEqual([])
    expect(onCommentCountChange).toHaveBeenLastCalledWith('post-1', 0, 3)
    expect(onCommentCountChange).not.toHaveBeenCalledWith('post-1', -1)
  })

  it('keeps an uncertain optimistic comment when canonical GET also fails', async () => {
    const { result, onCommentCountChange, showToast } = renderCommentsHook()
    await loadInitial(result, [], 3)
    mockAuthedFetch.mockRejectedValueOnce(new Error('offline'))
    mockAuthedFetch.mockResolvedValueOnce(unavailable())

    await act(async () => result.current.submitComment('post-1', 'still uncertain'))

    expect(result.current.comments[0].id).toMatch(/^temp_/)
    expect(onCommentCountChange).not.toHaveBeenCalledWith('post-1', -1)
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')
  })

  it('rolls back only a definitive HTTP rejection without canonical GET', async () => {
    const { result, onCommentCountChange } = renderCommentsHook()
    await loadInitial(result, [], 3)
    mockAuthedFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { success: false, error: 'rejected' },
    })

    await act(async () => result.current.submitComment('post-1', 'rejected'))

    expect(result.current.comments).toEqual([])
    expect(onCommentCountChange).toHaveBeenCalledWith('post-1', -1)
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('preserves a newer reaction event when HTTP and canonical GET both fail', async () => {
    const initial = comment()
    const { result } = renderCommentsHook()
    await loadInitial(result, [initial], 1)

    let rejectMutation: ((error: Error) => void) | undefined
    mockAuthedFetch.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMutation = reject
      })
    )
    mockAuthedFetch.mockResolvedValueOnce(unavailable())

    let request: Promise<void>
    act(() => {
      request = result.current.toggleCommentLike('post-1', initial.id)
    })
    const realtimeTruth = comment({ user_liked: true, like_count: 20, dislike_count: 4 })
    act(() => result.current.setComments([realtimeTruth]))

    await act(async () => {
      rejectMutation?.(new Error('response lost'))
      await request!
    })

    expect(result.current.comments).toEqual([realtimeTruth])
  })

  it('treats a malformed 2xx reaction ACK as unknown and reads canonical truth', async () => {
    const initial = comment()
    const canonicalReaction = comment({ user_liked: true, like_count: 1 })
    const { result } = renderCommentsHook()
    await loadInitial(result, [initial], 1)
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { success: true, data: { like_count: 1 } },
    })
    mockAuthedFetch.mockResolvedValueOnce(canonical([canonicalReaction], 1))

    await act(async () => result.current.toggleCommentLike('post-1', initial.id))

    expect(result.current.comments).toEqual([canonicalReaction])
  })

  it('does not let a valid but older reaction ACK overwrite newer Realtime truth', async () => {
    const initial = comment()
    const { result } = renderCommentsHook()
    await loadInitial(result, [initial], 1)

    let resolveMutation: ((value: unknown) => void) | undefined
    mockAuthedFetch.mockReturnValueOnce(new Promise((resolve) => (resolveMutation = resolve)))

    let request: Promise<void>
    act(() => {
      request = result.current.toggleCommentLike('post-1', initial.id)
    })
    const realtimeTruth = comment({ user_liked: true, like_count: 20, dislike_count: 4 })
    act(() => result.current.setComments([realtimeTruth]))

    await act(async () => {
      resolveMutation?.({
        ok: true,
        status: 200,
        data: {
          success: true,
          data: { liked: true, disliked: false, like_count: 1, dislike_count: 0 },
        },
      })
      await request!
    })

    expect(result.current.comments).toEqual([realtimeTruth])
  })

  it('reconciles a reply and absolute count after response loss', async () => {
    const parent = comment({ id: 'parent', replies: [] })
    const serverReply = comment({ id: 'server-reply', content: 'reply' })
    const canonicalParent = { ...parent, replies: [serverReply] }
    const { result, onCommentCountChange } = renderCommentsHook()
    await loadInitial(result, [parent], 1)
    mockAuthedFetch.mockRejectedValueOnce(new Error('response lost'))
    mockAuthedFetch.mockResolvedValueOnce(canonical([canonicalParent], 2))

    await act(async () => result.current.submitReply('post-1', parent.id, 'reply'))

    expect(result.current.comments).toEqual([canonicalParent])
    expect(onCommentCountChange).toHaveBeenLastCalledWith('post-1', 0, 2)
    expect(onCommentCountChange).not.toHaveBeenCalledWith('post-1', -1)
  })
})

describe('usePostComments uncertain edit reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  async function beginEdit(result: ReturnType<typeof renderCommentsHook>['result']) {
    const initial = comment()
    await loadInitial(result, [initial], 1)
    act(() => {
      result.current.startEditComment(initial)
      result.current.setEditContent('edited')
    })
    return initial
  }

  it('applies a strict resource-bound edit ACK without an extra canonical read', async () => {
    const { result } = renderCommentsHook()
    await beginEdit(result)
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { success: true, data: { comment: editedAcknowledgement('edited') } },
    })

    await act(async () => result.current.submitEditComment('post-1'))

    expect(result.current.comments[0]).toMatchObject({
      id: 'comment-1',
      content: 'edited',
      updated_at: '2026-07-15T21:00:00.000Z',
    })
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('response lost + DB committed → canonical GET applies edited content', async () => {
    const { result } = renderCommentsHook()
    await beginEdit(result)
    const edited = comment({ content: 'edited', updated_at: '2026-07-15T21:00:00.000Z' })
    mockAuthedFetch.mockRejectedValueOnce(new Error('response lost'))
    mockAuthedFetch.mockResolvedValueOnce(canonical([edited], 1))

    await act(async () => result.current.submitEditComment('post-1'))

    expect(result.current.comments).toEqual([edited])
  })

  it('response lost + DB not committed → canonical GET restores original content', async () => {
    const { result } = renderCommentsHook()
    const initial = await beginEdit(result)
    mockAuthedFetch.mockRejectedValueOnce(new Error('response lost'))
    mockAuthedFetch.mockResolvedValueOnce(canonical([initial], 1))

    await act(async () => result.current.submitEditComment('post-1'))

    expect(result.current.comments).toEqual([initial])
  })

  it('malformed 2xx ACK → canonical GET replaces the tree', async () => {
    const { result } = renderCommentsHook()
    await beginEdit(result)
    const edited = comment({ content: 'edited' })
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { success: true, data: { comment: { id: 'comment-1', content: 'edited' } } },
    })
    mockAuthedFetch.mockResolvedValueOnce(canonical([edited], 1))

    await act(async () => result.current.submitEditComment('post-1'))

    expect(result.current.comments).toEqual([edited])
  })

  it('unknown mutation + failed canonical GET preserves the visible tree', async () => {
    const { result, showToast } = renderCommentsHook()
    const initial = await beginEdit(result)
    mockAuthedFetch.mockResolvedValueOnce(unavailable())
    mockAuthedFetch.mockResolvedValueOnce(unavailable())

    await act(async () => result.current.submitEditComment('post-1'))

    expect(result.current.comments).toEqual([initial])
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')
  })

  it('does not apply a valid old-post ACK after switching posts', async () => {
    const { result } = renderCommentsHook()
    await beginEdit(result)
    let resolveMutation: ((value: unknown) => void) | undefined
    mockAuthedFetch.mockReturnValueOnce(new Promise((resolve) => (resolveMutation = resolve)))

    let request: Promise<void>
    act(() => {
      request = result.current.submitEditComment('post-1')
    })
    const postTwoComment = comment({ id: 'comment-2', post_id: 'post-2', content: 'post two' })
    await loadInitial(result, [postTwoComment], 1, 'post-2')

    await act(async () => {
      resolveMutation?.({
        ok: true,
        status: 200,
        data: { success: true, data: { comment: editedAcknowledgement('edited') } },
      })
      await request!
    })

    expect(result.current.comments).toEqual([postTwoComment])
  })
})

describe('usePostComments uncertain delete reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  it('response lost + DB committed → canonical GET removes the comment and sets count', async () => {
    const initial = comment()
    const { result, onCommentCountChange } = renderCommentsHook()
    await loadInitial(result, [initial], 1)
    mockAuthedFetch.mockRejectedValueOnce(new Error('response lost'))
    mockAuthedFetch.mockResolvedValueOnce(canonical([], 0))

    await act(async () => result.current.deleteComment('post-1', initial.id))

    expect(result.current.comments).toEqual([])
    expect(onCommentCountChange).toHaveBeenLastCalledWith('post-1', 0, 0)
  })

  it('response lost + DB not committed → canonical GET keeps the comment', async () => {
    const initial = comment()
    const { result } = renderCommentsHook()
    await loadInitial(result, [initial], 1)
    mockAuthedFetch.mockRejectedValueOnce(new Error('response lost'))
    mockAuthedFetch.mockResolvedValueOnce(canonical([initial], 1))

    await act(async () => result.current.deleteComment('post-1', initial.id))

    expect(result.current.comments).toEqual([initial])
  })

  it('malformed 2xx ACK → canonical GET supplies the result', async () => {
    const initial = comment()
    const { result } = renderCommentsHook()
    await loadInitial(result, [initial], 1)
    mockAuthedFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { success: true, data: { deleted_count: 1 } },
    })
    mockAuthedFetch.mockResolvedValueOnce(canonical([], 0))

    await act(async () => result.current.deleteComment('post-1', initial.id))

    expect(result.current.comments).toEqual([])
  })

  it('unknown mutation + failed canonical GET preserves the comment', async () => {
    const initial = comment()
    const { result, showToast } = renderCommentsHook()
    await loadInitial(result, [initial], 1)
    mockAuthedFetch.mockResolvedValueOnce(unavailable())
    mockAuthedFetch.mockResolvedValueOnce(unavailable())

    await act(async () => result.current.deleteComment('post-1', initial.id))

    expect(result.current.comments).toEqual([initial])
    expect(showToast).toHaveBeenCalledWith('networkError', 'error')
  })

  it('does not let an old-post DELETE response mutate a newly loaded post', async () => {
    const initial = comment()
    const { result } = renderCommentsHook()
    await loadInitial(result, [initial], 1)
    let resolveMutation: ((value: unknown) => void) | undefined
    mockAuthedFetch.mockReturnValueOnce(new Promise((resolve) => (resolveMutation = resolve)))

    let request: Promise<void>
    await act(async () => {
      request = result.current.deleteComment('post-1', initial.id)
      await Promise.resolve()
    })
    const postTwoComment = comment({ id: 'comment-2', post_id: 'post-2', content: 'post two' })
    await loadInitial(result, [postTwoComment], 1, 'post-2')

    await act(async () => {
      resolveMutation?.({
        ok: true,
        status: 200,
        data: { success: true, data: { deleted_count: 1, comment_count: 0 } },
      })
      await request!
    })

    expect(result.current.comments).toEqual([postTwoComment])
  })
})
