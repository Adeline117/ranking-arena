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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

const refreshedPostId = '11111111-1111-4111-8111-111111111111'
const refreshedRawPost = {
  id: refreshedPostId,
  group_id: null,
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
  user_reaction: null,
}

function postsPage(posts: unknown[]) {
  return {
    success: true,
    data: { posts },
    meta: {
      pagination: { limit: 30, offset: 0, has_more: false },
      timestamp: '2026-08-03T12:00:00.000Z',
    },
  }
}

function groupsPage(groups: unknown[], total = groups.length) {
  return {
    success: true,
    data: {
      groups,
      pagination: { limit: 30, offset: 0, total, has_more: false },
    },
  }
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
      .mockResolvedValueOnce(response(200, postsPage([refreshedRawPost])))

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(result.current.postsError).not.toBeNull())

    await act(async () => {
      await result.current.refreshPosts()
    })

    expect(result.current.postsError).toBeNull()
    expect(result.current.visibleHot).toHaveLength(1)
    expect(result.current.visibleHot[0]).toMatchObject({
      id: refreshedPostId,
      title: 'Fresh post',
      body: 'fresh',
    })
  })

  it('enters no-data only after a successful validated empty response', async () => {
    mockFetch.mockResolvedValueOnce(response(200, postsPage([])))

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))

    await waitFor(() => expect(result.current.visibleHot).toEqual([]))
    expect(result.current.postsError).toBeNull()
    expect(result.current.loadingPosts).toBe(false)
  })

  it('distinguishes a failed groups request from empty and retries it', async () => {
    const group = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Builders',
      name_en: null,
      description: null,
      avatar_url: null,
      member_count: 7,
    }
    let groupAttempts = 0
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return response(200, postsPage([]))
      if (url.startsWith('/api/groups')) {
        groupAttempts += 1
        return groupAttempts === 1
          ? response(503, { success: false, error: 'offline' })
          : response(200, groupsPage([group]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    act(() => result.current.setActiveHotTab('groups'))

    await waitFor(() => expect(result.current.groupsError).not.toBeNull())
    expect(result.current.groups).toEqual([])

    await act(async () => result.current.refreshGroups())
    expect(result.current.groupsError).toBeNull()
    expect(result.current.groups).toEqual([
      { id: group.id, name: 'Builders', name_en: null, member_count: 7 },
    ])
  })

  it('keeps last-good groups when a later response is malformed', async () => {
    const group = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Risk lab',
      name_en: null,
      description: null,
      avatar_url: null,
      member_count: 4,
    }
    let groupAttempts = 0
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return response(200, postsPage([]))
      if (url.startsWith('/api/groups')) {
        groupAttempts += 1
        return groupAttempts === 1
          ? response(200, groupsPage([group]))
          : response(200, { success: true, data: { groups: [] } })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    act(() => result.current.setActiveHotTab('groups'))
    await waitFor(() => expect(result.current.groups).toHaveLength(1))

    await act(async () => result.current.refreshGroups())
    expect(result.current.groupsError).not.toBeNull()
    expect(result.current.groups).toHaveLength(1)
  })

  it('discards a late posts response after the viewer scope changes', async () => {
    const requestA = deferred<ReturnType<typeof response>>()
    const requestB = deferred<ReturnType<typeof response>>()
    const postA = { ...refreshedRawPost, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
    const postB = {
      ...refreshedRawPost,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Viewer B post',
    }
    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-a',
      authChecked: true,
      email: 'a@example.com',
      userId: 'aaaaaaaa-0000-4000-8000-000000000000',
      viewerKey: 'user:a',
      sessionGeneration: 1,
    })
    mockFetch.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization
      return authorization === 'Bearer token-a' ? requestA.promise : requestB.promise
    })

    const { result, rerender } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockUseAuthSession.mockReturnValue({
      accessToken: 'token-b',
      authChecked: true,
      email: 'b@example.com',
      userId: 'bbbbbbbb-0000-4000-8000-000000000000',
      viewerKey: 'user:b',
      sessionGeneration: 2,
    })
    rerender()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      requestB.resolve(response(200, postsPage([postB])))
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.visibleHot[0]?.title).toBe('Viewer B post'))

    await act(async () => {
      requestA.resolve(response(200, postsPage([postA])))
      await Promise.resolve()
    })
    expect(result.current.visibleHot[0]?.id).toBe(postB.id)
  })
})
