import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetchPostCommentsPage = jest.fn()

jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))
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

function renderGroupHook(
  initialProps: Props,
  onRender?: (comments: Record<string, CommentWithAuthor[]>) => void
) {
  return renderHook(
    (props: Props) => {
      const value = useGroupPosts({
        groupId: 'group-1',
        ...props,
        language: 'en',
        t: (key) => key,
        showToast: jest.fn(),
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
      userId: 'user-a',
      viewerKey: 'user:user-a',
      isMember: true,
    }
    const requestA = deferred<unknown>()
    mockAuthedFetch.mockReturnValueOnce(requestA.promise)
    const { result, rerender } = renderGroupHook(userA)

    let mutation!: Promise<void>
    act(() => {
      mutation = result.current.handleLike('post-1')
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/posts/post-1/like',
      'POST',
      'token-a',
      { reaction_type: 'up' },
      15_000,
      { expectedUserId: 'user-a', expectedSessionGeneration: 1 }
    )

    rerender({
      ...userA,
      accessToken: 'token-b',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    expect(result.current.likeLoading).toEqual({})

    await act(async () => {
      requestA.resolve({ ok: true, status: 200, data: { success: true } })
      await mutation
    })

    expect(result.current.likeLoading).toEqual({})
    expect(result.current.posts).toEqual([])
  })
})
