import { act, renderHook, waitFor } from '@testing-library/react'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: { getState: () => ({ openLoginModal: jest.fn() }) },
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}))

import { useHotPageData } from '../useHotPageData'
import type { Post } from '../types'

const initialPost: Post = {
  id: 'ssr-post',
  group: 'General',
  title: 'SSR last-good post',
  author: 'arena',
  time: 'now',
  body: 'last-good',
  comments: 1,
  likes: 2,
  dislikes: 0,
  hotScore: 10,
  views: 3,
  created_at: '2026-07-18T12:00:00.000Z',
}

const refreshedRawPost = {
  id: 'fresh-post',
  group_name: 'General',
  title: 'Fresh post',
  author_handle: 'trader',
  content: 'fresh',
  comment_count: 2,
  like_count: 4,
  dislike_count: 0,
  hot_score: 20,
  view_count: 5,
  created_at: '2026-07-18T13:00:00.000Z',
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  }
}

describe('useHotPageData post last-good behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockUseAuthSession.mockReturnValue({
      accessToken: null,
      authChecked: true,
      email: null,
      userId: null,
      viewerKey: 'anon',
      sessionGeneration: 0,
    })
    global.fetch = mockFetch as never
  })

  it('throws non-2xx into an explicit error state without replacing SSR posts', async () => {
    const failedResponse = response(500, { error: 'database unavailable' })
    mockFetch.mockResolvedValueOnce(failedResponse)

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))

    await waitFor(() => expect(result.current.postsError?.message).toContain('500'))
    expect(result.current.loadingPosts).toBe(false)
    expect(result.current.visibleHot).toEqual([initialPost])
    expect(failedResponse.json).not.toHaveBeenCalled()
    expect(mockShowToast).toHaveBeenCalledWith('loadHotPostsFailed', 'error')
  })

  it('allows an in-place retry to replace last-good posts and clear the error', async () => {
    mockFetch
      .mockResolvedValueOnce(response(503, { error: 'temporarily unavailable' }))
      .mockResolvedValueOnce(response(200, { data: { posts: [refreshedRawPost] } }))

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.postsError).not.toBeNull())

    await act(async () => {
      await result.current.refreshPosts()
    })

    expect(result.current.postsError).toBeNull()
    expect(result.current.visibleHot).toHaveLength(1)
    expect(result.current.visibleHot[0]).toMatchObject({
      id: 'fresh-post',
      title: 'Fresh post',
      body: 'fresh',
    })
  })

  it('enters no-data only after a successful validated empty response', async () => {
    mockFetch.mockResolvedValueOnce(response(200, { data: { posts: [] } }))

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))

    await waitFor(() => expect(result.current.visibleHot).toEqual([]))
    expect(result.current.postsError).toBeNull()
    expect(result.current.loadingPosts).toBe(false)
  })
})
