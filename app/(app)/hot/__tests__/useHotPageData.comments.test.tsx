import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetchPostCommentsPage = jest.fn()
const mockAuthedFetch = jest.fn()
const mockFetch = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }
const mockSearchParams = new URLSearchParams()
const mockT = (key: string) => key
const mockShowToast = jest.fn()

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
  default: { error: jest.fn(), warn: jest.fn() },
}))

import { useHotPageData } from '../useHotPageData'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import type { Comment, Post } from '../types'

const mockUseAuthSession = useAuthSession as jest.Mock

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function page(comments: Comment[], commentCount: number) {
  return {
    ok: true,
    status: 200,
    comments,
    commentCount,
    hasMore: false,
  }
}

const post: Post = {
  id: 'post-1',
  group: 'General',
  title: 'Post',
  author: 'user',
  time: 'now',
  body: 'body',
  comments: 1,
  likes: 0,
  dislikes: 0,
  hotScore: 1,
  views: 0,
  created_at: '2026-07-15T20:00:00.000Z',
}

const initialComment: Comment = {
  id: 'comment-1',
  user_id: 'user-2',
  content: 'first',
  created_at: '2026-07-15T20:00:00.000Z',
}

const committedComment: Comment = {
  id: 'comment-2',
  user_id: 'user-1',
  content: 'hello',
  created_at: '2026-07-15T21:00:00.000Z',
}

describe('useHotPageData comment mutation reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-1',
      authChecked: true,
      email: 'user@example.com',
      userId: 'user-1',
      viewerKey: 'user:user-1',
      sessionGeneration: 1,
    })
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 500,
      data: { success: false, error: 'response lost' },
    })
    global.fetch = mockFetch as never
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'response lost' }),
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { posts: [] } }),
      })
    })
  })

  it('uses an authenticated canonical GET after 5xx and applies tree + absolute count', async () => {
    mockFetchPostCommentsPage
      .mockResolvedValueOnce(page([initialComment], 1))
      .mockResolvedValueOnce(page([initialComment, committedComment], 2))
    const { result } = renderHook(() => useHotPageData({ initialPosts: [post] }))

    act(() => result.current.handleOpenPost(post))
    await waitFor(() => expect(result.current.comments).toEqual([initialComment]))

    act(() => result.current.setNewComment('hello'))
    await act(async () => result.current.submitComment('post-1'))

    expect(mockFetchPostCommentsPage).toHaveBeenLastCalledWith('post-1', 'token-1', {
      limit: 10,
      offset: 0,
      viewerScope: { expectedUserId: 'user-1', expectedSessionGeneration: 1 },
    })
    expect(result.current.comments).toEqual([initialComment, committedComment])
    expect(result.current.openPost?.comments).toBe(2)
    expect(result.current.newComment).toBe('hello')
  })

  it('preserves the current tree and draft when the mutation and canonical GET both fail', async () => {
    mockFetchPostCommentsPage
      .mockResolvedValueOnce(page([initialComment], 1))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        comments: [],
        commentCount: 0,
        hasMore: false,
      })
    const { result } = renderHook(() => useHotPageData({ initialPosts: [post] }))

    act(() => result.current.handleOpenPost(post))
    await waitFor(() => expect(result.current.comments).toEqual([initialComment]))
    act(() => result.current.setNewComment('hello'))

    await act(async () => result.current.submitComment('post-1'))

    expect(result.current.comments).toEqual([initialComment])
    expect(result.current.openPost?.comments).toBe(1)
    expect(result.current.newComment).toBe('hello')
  })

  it('reloads the same open post for B and discards the late A GET', async () => {
    const requests = new Map<string, (value: unknown) => void>()
    const renderSnapshots: string[][] = []
    mockFetchPostCommentsPage.mockImplementation(
      (_postId: string, token: string) =>
        new Promise((resolve) => {
          requests.set(token, resolve)
        })
    )
    const commentB: Comment = {
      id: 'comment-b',
      user_id: 'user-b',
      content: 'B state',
      created_at: '2026-07-15T22:00:00.000Z',
    }
    const { result, rerender } = renderHook(() => {
      const value = useHotPageData({ initialPosts: [post] })
      renderSnapshots.push(value.comments.map((comment) => comment.id))
      return value
    })
    act(() => result.current.handleOpenPost(post))
    await waitFor(() => expect(requests.has('token-1')).toBe(true))

    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-b',
      authChecked: true,
      email: 'b@example.com',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    const firstBRender = renderSnapshots.length
    rerender()
    await waitFor(() => expect(requests.has('token-b')).toBe(true))
    expect(
      renderSnapshots
        .slice(firstBRender)
        .every((commentIds) => !commentIds.includes(initialComment.id))
    ).toBe(true)

    await act(async () => {
      requests.get('token-b')?.(page([commentB], 1))
      await Promise.resolve()
    })
    await act(async () => {
      requests.get('token-1')?.(page([initialComment], 1))
      await Promise.resolve()
    })

    expect(result.current.comments).toEqual([commentB])
  })

  it('keeps the A tree and avoids a reload for a same-A token refresh', async () => {
    mockFetchPostCommentsPage.mockResolvedValue(page([initialComment], 1))
    const { result, rerender } = renderHook(() => useHotPageData({ initialPosts: [post] }))
    act(() => result.current.handleOpenPost(post))
    await waitFor(() => expect(result.current.comments).toEqual([initialComment]))
    const readsBeforeRefresh = mockFetchPostCommentsPage.mock.calls.length

    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-2',
      authChecked: true,
      email: 'user@example.com',
      userId: 'user-1',
      viewerKey: 'user:user-1',
      sessionGeneration: 1,
    })
    rerender()

    expect(result.current.comments).toEqual([initialComment])
    expect(mockFetchPostCommentsPage).toHaveBeenCalledTimes(readsBeforeRefresh)
  })

  it('rejects a late A translation after B opens the same post', async () => {
    const translations = new Map<string, ReturnType<typeof deferred<unknown>>>()
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/translate' && options?.method === 'POST') {
        const authorization = (options.headers as Record<string, string>)?.Authorization
        const request = deferred<unknown>()
        translations.set(authorization, request)
        return request.promise
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { posts: [] } }),
      })
    })
    const translatedPost = { ...post, body: '中文内容' }
    const { result, rerender } = renderHook(() => useHotPageData())

    act(() => result.current.handleOpenPost(translatedPost))
    await waitFor(() => expect(translations.has('Bearer token-1')).toBe(true))

    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-b',
      authChecked: true,
      email: 'b@example.com',
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    rerender()
    expect(result.current.translatedContent).toBeNull()

    act(() => result.current.handleOpenPost(translatedPost))
    await waitFor(() => expect(translations.has('Bearer token-b')).toBe(true))

    await act(async () => {
      translations.get('Bearer token-1')?.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ success: true, data: { translatedText: 'A private translation' } }),
      })
      await Promise.resolve()
    })
    expect(result.current.translatedContent).toBeNull()

    await act(async () => {
      translations.get('Bearer token-b')?.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: { translatedText: 'B translation' } }),
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.translatedContent).toBe('B translation'))
  })
})
