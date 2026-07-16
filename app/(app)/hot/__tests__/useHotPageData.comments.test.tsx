import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetchPostCommentsPage = jest.fn()
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
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }))
jest.mock('@/lib/api/comments-client', () => {
  const actual = jest.requireActual('@/lib/api/comments-client')
  return {
    ...actual,
    fetchPostCommentsPage: (...args: unknown[]) => mockFetchPostCommentsPage(...args),
  }
})
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    accessToken: 'token-1',
    authChecked: true,
    email: 'user@example.com',
    userId: 'user-1',
  }),
}))
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
import type { Comment, Post } from '../types'

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
})
