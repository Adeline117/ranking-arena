import { act, renderHook, waitFor } from '@testing-library/react'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import type { Post } from '../types'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }
const mockT = (key: string) => key
let mockLanguage: 'zh' | 'en' | 'ja' | 'ko' = 'en'

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/lib/hooks/useModalA11y', () => ({ useModalA11y: jest.fn() }))
jest.mock('@/lib/api/client', () => ({
  authedFetch: jest.fn(),
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-test' }),
}))
jest.mock('@/lib/api/comments-client', () => {
  const actual = jest.requireActual('@/lib/api/comments-client')
  return {
    ...actual,
    fetchPostCommentsPage: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      comments: [],
      commentCount: 0,
      hasMore: false,
    }),
  }
})
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: mockLanguage, t: mockT }),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response
}

function emptyPostsPage() {
  return {
    success: true,
    data: { posts: [] },
    meta: {
      pagination: { limit: 30, offset: 0, has_more: false },
      timestamp: '2026-08-04T00:00:00.000Z',
    },
  }
}

function singleEnvelope(
  originalText: string,
  targetLang: 'zh' | 'en' | 'ja' | 'ko',
  translatedText: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    success: true,
    data: {
      translatedText,
      originalText,
      targetLang,
      cached: false,
      ...overrides,
    },
  }
}

function batchEnvelope(
  results: Record<string, { translatedText: string; cached: boolean }>,
  total = Object.keys(results).length
) {
  return {
    success: true,
    data: { results, total, cached: 0, translated: total },
  }
}

function requestBody(options?: RequestInit) {
  return JSON.parse(options?.body as string) as {
    text?: string
    targetLang: 'zh' | 'en' | 'ja' | 'ko'
    items?: Array<{ id: string; text: string; contentId: string }>
  }
}

const modalPost: Post = {
  id: 'post-1',
  group: 'General',
  title: 'Post',
  author: 'arena',
  time: 'now',
  body: '中文内容',
  comments: 0,
  likes: 0,
  dislikes: 0,
  hotScore: 1,
  views: 0,
  created_at: '2026-08-03T00:00:00.000Z',
}

const rawHotPost = {
  id: 'post_with_underscore',
  group_id: null,
  group_name: 'General',
  group_name_en: 'General',
  title: 'English title',
  author_handle: 'arena',
  author_avatar_url: null,
  content: 'English body',
  comment_count: 0,
  like_count: 0,
  dislike_count: 0,
  hot_score: 1,
  view_count: 0,
  created_at: '2026-08-03T00:00:00.000Z',
  user_reaction: null,
}

const listPost: Post = {
  id: rawHotPost.id,
  group: 'General',
  group_en: 'General',
  title: rawHotPost.title,
  author: rawHotPost.author_handle,
  time: 'now',
  body: rawHotPost.content,
  comments: 0,
  likes: 0,
  dislikes: 0,
  hotScore: 1,
  views: 0,
  created_at: rawHotPost.created_at,
}

function authenticatedSession(accessToken = 'token-a') {
  return {
    accessToken,
    authChecked: true,
    email: 'user@example.com',
    userId: '11111111-1111-4111-8111-111111111111',
    viewerKey: 'user:11111111-1111-4111-8111-111111111111',
    sessionGeneration: 1,
  }
}

describe('useHotPageData translation truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
    mockLanguage = 'en'
    mockUseAuthSession.mockReturnValue(authenticatedSession())
    global.fetch = mockFetch as never
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('rejects an unbound single receipt, releases loading, and does not cache the failure', async () => {
    let translationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') {
        translationAttempts += 1
        return Promise.resolve(
          response(
            translationAttempts === 1
              ? singleEnvelope('别人的原文', 'en', 'Wrong receipt')
              : singleEnvelope(modalPost.body, 'en', 'Bound translation')
          )
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData())

    act(() => result.current.handleOpenPost(modalPost))
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('translationServiceError', 'error')
    )
    expect(result.current.translatedContent).toBeNull()
    expect(result.current.showingOriginal).toBe(true)
    expect(result.current.translating).toBe(false)

    act(() => result.current.handleOpenPost(modalPost))
    await waitFor(() => expect(result.current.translatedContent).toBe('Bound translation'))
    expect(translationAttempts).toBe(2)
  })

  it('coalesces identical modal requests into one physical call', async () => {
    const translation = deferred<Response>()
    let translationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') {
        translationAttempts += 1
        return translation.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData())

    act(() => {
      result.current.handleOpenPost(modalPost)
      result.current.handleOpenPost(modalPost)
    })
    expect(translationAttempts).toBe(1)

    translation.resolve(response(singleEnvelope(modalPost.body, 'en', 'One translation')))
    await waitFor(() => expect(result.current.translatedContent).toBe('One translation'))
    expect(result.current.translating).toBe(false)
  })

  it('authorizes translation from the bearer session without requiring an email claim', async () => {
    mockUseAuthSession.mockReturnValue({ ...authenticatedSession(), email: null })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') {
        return Promise.resolve(response(singleEnvelope(modalPost.body, 'en', 'Bearer translation')))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData())

    act(() => result.current.handleOpenPost(modalPost))

    await waitFor(() => expect(result.current.translatedContent).toBe('Bearer translation'))
  })

  it('releases modal loading at the physical deadline when fetch ignores AbortSignal', async () => {
    jest.useFakeTimers()
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') return new Promise(() => undefined)
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData())

    act(() => result.current.handleOpenPost(modalPost))
    expect(result.current.translating).toBe(true)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
    })

    expect(result.current.translating).toBe(false)
    expect(result.current.translatedContent).toBeNull()
    expect(mockShowToast).toHaveBeenCalledWith('translationServiceError', 'error')
  })

  it('isolates a late response after a same-viewer token refresh', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') {
        const authorization = (options?.headers as Record<string, string>).Authorization
        const pending = deferred<Response>()
        requests.set(authorization, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result, rerender } = renderHook(() => useHotPageData())
    act(() => result.current.handleOpenPost(modalPost))
    await waitFor(() => expect(requests.has('Bearer token-a')).toBe(true))

    mockUseAuthSession.mockReturnValue(authenticatedSession('token-b'))
    rerender()
    await waitFor(() => expect(requests.has('Bearer token-b')).toBe(true))

    requests
      .get('Bearer token-a')
      ?.resolve(response(singleEnvelope(modalPost.body, 'en', 'Stale token translation')))
    await act(async () => Promise.resolve())
    expect(result.current.translatedContent).toBeNull()

    requests
      .get('Bearer token-b')
      ?.resolve(response(singleEnvelope(modalPost.body, 'en', 'Fresh token translation')))
    await waitFor(() => expect(result.current.translatedContent).toBe('Fresh token translation'))
  })

  it('isolates late content for the same post ID after its source changes', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') {
        const body = requestBody(options)
        const pending = deferred<Response>()
        requests.set(body.text as string, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData())
    const updatedPost = { ...modalPost, body: '更新后的中文内容' }

    act(() => result.current.handleOpenPost(modalPost))
    await waitFor(() => expect(requests.has(modalPost.body)).toBe(true))
    act(() => result.current.handleOpenPost(updatedPost))
    await waitFor(() => expect(requests.has(updatedPost.body)).toBe(true))

    requests
      .get(modalPost.body)
      ?.resolve(response(singleEnvelope(modalPost.body, 'en', 'Stale content')))
    await act(async () => Promise.resolve())
    expect(result.current.translatedContent).toBeNull()

    requests
      .get(updatedPost.body)
      ?.resolve(response(singleEnvelope(updatedPost.body, 'en', 'Fresh content')))
    await waitFor(() => expect(result.current.translatedContent).toBe('Fresh content'))
  })

  it('publishes a complete Japanese batch with opaque IDs and underscore-safe post mapping', async () => {
    mockLanguage = 'ja'
    let capturedBody: ReturnType<typeof requestBody> | undefined
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        capturedBody = requestBody(options)
        return Promise.resolve(
          response(
            batchEnvelope({
              'item-0': { translatedText: '日本語タイトル', cached: false },
              'item-1': { translatedText: '日本語本文', cached: false },
            })
          )
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: [listPost] }))

    await waitFor(() =>
      expect(result.current.translatedListPosts.post_with_underscore).toEqual({
        title: '日本語タイトル',
        body: '日本語本文',
      })
    )
    expect(capturedBody?.targetLang).toBe('ja')
    expect(capturedBody?.items?.map((item) => item.id)).toEqual(['item-0', 'item-1'])
    expect(result.current.translatingList).toBe(false)
  })

  it('publishes none of an incomplete batch and releases list loading', async () => {
    mockLanguage = 'ja'
    let translationAttempts = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        translationAttempts += 1
        return Promise.resolve(
          response(batchEnvelope({ 'item-0': { translatedText: '只有标题', cached: false } }, 2))
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: [listPost] }))

    await waitFor(() => expect(translationAttempts).toBe(1))
    await waitFor(() => expect(result.current.translatingList).toBe(false))
    expect(result.current.translatedListPosts).toEqual({})
  })

  it('clears list cache and rejects a late batch after the UI language changes', async () => {
    mockLanguage = 'ja'
    const requests = new Map<
      'ja' | 'ko',
      { pending: ReturnType<typeof deferred<Response>>; itemIds: string[] }
    >()
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        const body = requestBody(options)
        const pending = deferred<Response>()
        requests.set(body.targetLang as 'ja' | 'ko', {
          pending,
          itemIds: body.items?.map((item) => item.id) ?? [],
        })
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result, rerender } = renderHook(() => useHotPageData({ initialPosts: [listPost] }))
    await waitFor(() => expect(requests.has('ja')).toBe(true))

    mockLanguage = 'ko'
    rerender()
    await waitFor(() => expect(requests.has('ko')).toBe(true))

    const japanese = requests.get('ja')!
    japanese.pending.resolve(
      response(
        batchEnvelope(
          Object.fromEntries(
            japanese.itemIds.map((id) => [id, { translatedText: `stale-${id}`, cached: false }])
          )
        )
      )
    )
    await act(async () => Promise.resolve())
    expect(result.current.translatedListPosts).toEqual({})

    const korean = requests.get('ko')!
    korean.pending.resolve(
      response(
        batchEnvelope({
          [korean.itemIds[0]]: { translatedText: '한국어 제목', cached: false },
          [korean.itemIds[1]]: { translatedText: '한국어 본문', cached: false },
        })
      )
    )
    await waitFor(() =>
      expect(result.current.translatedListPosts.post_with_underscore).toEqual({
        title: '한국어 제목',
        body: '한국어 본문',
      })
    )
    expect(result.current.translatingList).toBe(false)
  })

  it('does not publish an original-text echo from a complete batch', async () => {
    mockLanguage = 'ja'
    const bodyOnlyPost = { ...listPost, title: '' }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        return Promise.resolve(
          response(batchEnvelope({ 'item-0': { translatedText: bodyOnlyPost.body, cached: true } }))
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: [bodyOnlyPost] }))

    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([url]) => url === '/api/translate')).toBe(true)
    )
    await waitFor(() => expect(result.current.translatingList).toBe(false))
    expect(result.current.translatedListPosts).toEqual({})
  })
})
