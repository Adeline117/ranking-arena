import { act, renderHook, waitFor } from '@testing-library/react'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import type { Post } from '../types'

const mockFetch = jest.fn()
const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn()
const mockRouter = { push: jest.fn(), replace: jest.fn() }
const mockT = (key: string) => key
let mockLanguage: 'zh' | 'en' | 'ja' | 'ko' = 'en'
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const accessTokenFor = (subject: string, revision: string) =>
  `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature-${revision}`
const TOKEN_A = accessTokenFor(USER_A, 'a')
const TOKEN_B = accessTokenFor(USER_A, 'b')

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

function postsPage(posts: unknown[]) {
  return {
    success: true,
    data: { posts },
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
    items?: Array<{
      id: string
      text: string
      contentId: string
      contentType: 'post_title' | 'post_content'
    }>
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

function authenticatedSession(accessToken = TOKEN_A, userId = USER_A, sessionGeneration = 1) {
  return {
    accessToken,
    authChecked: true,
    isLoggedIn: true,
    email: 'user@example.com',
    userId,
    viewerKey: `user:${userId}`,
    sessionGeneration,
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
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_A}`)).toBe(true))

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B))
    rerender()
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_B}`)).toBe(true))

    requests
      .get(`Bearer ${TOKEN_A}`)
      ?.resolve(response(singleEnvelope(modalPost.body, 'en', 'Stale token translation')))
    await act(async () => Promise.resolve())
    expect(result.current.translatedContent).toBeNull()

    requests
      .get(`Bearer ${TOKEN_B}`)
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

  it.each([
    ['Japanese', '日本語の投稿です', 'Translated Japanese'],
    ['Korean', '한국어 게시물입니다', 'Translated Korean'],
  ])('translates exact %s modal content into English', async (_label, source, translated) => {
    let capturedBody: ReturnType<typeof requestBody> | undefined
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return Promise.resolve(response(emptyPostsPage()))
      if (url === '/api/translate') {
        capturedBody = requestBody(options)
        return Promise.resolve(response(singleEnvelope(source, 'en', translated)))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const scriptPost = { ...modalPost, body: source }
    const { result } = renderHook(() => useHotPageData())

    act(() => result.current.handleOpenPost(scriptPost))

    await waitFor(() => expect(result.current.translatedContent).toBe(translated))
    expect(capturedBody).toMatchObject({ text: source, targetLang: 'en' })
    expect(result.current.translating).toBe(false)
  })

  it('fails closed when the bearer subject does not match the rendered viewer', async () => {
    mockLanguage = 'ja'
    mockUseAuthSession.mockReturnValue(
      authenticatedSession(accessTokenFor(USER_B, 'mismatch'), USER_A)
    )
    const bodyOnlyPost = { ...listPost, title: '' }
    const { result } = renderHook(() => useHotPageData({ initialPosts: [bodyOnlyPost] }))

    act(() => result.current.handleOpenPost(modalPost))
    await act(async () => Promise.resolve())

    expect(mockFetch.mock.calls.filter(([url]) => url === '/api/translate')).toHaveLength(0)
    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatingList).toBe(false)
    expect(result.current.translatedContent).toBeNull()
    expect(result.current.translating).toBe(false)
  })

  it('fails closed instead of binding one translation to duplicate post IDs', async () => {
    mockLanguage = 'ja'
    const duplicatePosts = [
      { ...listPost, title: '', body: 'First source' },
      { ...listPost, title: '', body: 'Different source' },
    ]
    const { result } = renderHook(() => useHotPageData({ initialPosts: duplicatePosts }))

    await act(async () => Promise.resolve())

    expect(mockFetch.mock.calls.filter(([url]) => url === '/api/translate')).toHaveLength(0)
    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatingList).toBe(false)
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

  it('translates exact Japanese and Korean list sources into English', async () => {
    const scriptPosts: Post[] = [
      { ...listPost, id: 'post-ja', title: '', body: '日本語の本文です' },
      { ...listPost, id: 'post-ko', title: '', body: '한국어 본문입니다' },
    ]
    let capturedBody: ReturnType<typeof requestBody> | undefined
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        const body = requestBody(options)
        capturedBody = body
        return Promise.resolve(
          response(
            batchEnvelope({
              'item-0': { translatedText: 'Japanese body in English', cached: false },
              'item-1': { translatedText: 'Korean body in English', cached: false },
            })
          )
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: scriptPosts }))

    await waitFor(() =>
      expect(result.current.translatedListPosts).toEqual({
        'post-ja': { body: 'Japanese body in English' },
        'post-ko': { body: 'Korean body in English' },
      })
    )
    expect(capturedBody?.targetLang).toBe('en')
    expect(capturedBody?.items?.map(({ text }) => text)).toEqual([
      scriptPosts[0].body,
      scriptPosts[1].body,
    ])
    expect(result.current.translatingList).toBe(false)
  })

  it('sends every exact source and atomically publishes a list larger than one batch', async () => {
    mockLanguage = 'ja'
    const longBody = `Full body:${'x'.repeat(700)}:tail`
    const listPosts = Array.from(
      { length: 12 },
      (_, index): Post => ({
        ...listPost,
        id: `post-${index}`,
        title: `English title ${index}`,
        body: index === 0 ? longBody : `English body ${index}`,
      })
    )
    const capturedBodies: ReturnType<typeof requestBody>[] = []
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        const body = requestBody(options)
        capturedBodies.push(body)
        return Promise.resolve(
          response(
            batchEnvelope(
              Object.fromEntries(
                (body.items ?? []).map((item) => [
                  item.id,
                  {
                    translatedText: `translated:${item.contentId}:${item.contentType}`,
                    cached: false,
                  },
                ])
              )
            )
          )
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: listPosts }))

    await waitFor(() => expect(capturedBodies).toHaveLength(2))
    await waitFor(() =>
      expect(result.current.translatedListPosts['post-11']).toEqual({
        title: 'translated:post-11:post_title',
        body: 'translated:post-11:post_content',
      })
    )

    expect(capturedBodies.map((body) => body.items?.length)).toEqual([20, 4])
    expect(capturedBodies.flatMap((body) => body.items ?? []).map((item) => item.id)).toEqual(
      Array.from({ length: 24 }, (_, index) => `item-${index}`)
    )
    expect(
      capturedBodies
        .flatMap((body) => body.items ?? [])
        .find((item) => item.contentId === 'post-0' && item.contentType === 'post_content')?.text
    ).toBe(longBody)
    expect(Object.keys(result.current.translatedListPosts)).toHaveLength(12)
    expect(result.current.translatingList).toBe(false)
  })

  it('publishes no partial list while a later chunk is pending or invalid', async () => {
    mockLanguage = 'ja'
    const listPosts = Array.from(
      { length: 12 },
      (_, index): Post => ({
        ...listPost,
        id: `post-${index}`,
        title: `English title ${index}`,
        body: `English body ${index}`,
      })
    )
    const requests: Array<{
      body: ReturnType<typeof requestBody>
      pending: ReturnType<typeof deferred<Response>>
    }> = []
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        const pending = deferred<Response>()
        requests.push({ body: requestBody(options), pending })
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: listPosts }))
    await waitFor(() => expect(requests).toHaveLength(2))

    const firstResults = Object.fromEntries(
      (requests[0].body.items ?? []).map((item) => [
        item.id,
        { translatedText: `first:${item.id}`, cached: false },
      ])
    )
    requests[0].pending.resolve(response(batchEnvelope(firstResults)))
    await act(async () => Promise.resolve())
    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatingList).toBe(true)

    const secondItems = requests[1].body.items ?? []
    requests[1].pending.resolve(
      response(
        batchEnvelope(
          {
            [secondItems[0].id]: { translatedText: 'incomplete', cached: false },
          },
          secondItems.length
        )
      )
    )
    await waitFor(() => expect(result.current.translatingList).toBe(false))
    expect(result.current.translatedListPosts).toEqual({})
  })

  it('isolates a late list batch after a same-viewer token refresh', async () => {
    mockLanguage = 'ja'
    const bodyOnlyPost = { ...listPost, title: '' }
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        const authorization = (options?.headers as Record<string, string>).Authorization
        const pending = deferred<Response>()
        requests.set(authorization, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result, rerender } = renderHook(() => useHotPageData({ initialPosts: [bodyOnlyPost] }))
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_A}`)).toBe(true))

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B))
    rerender()
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_B}`)).toBe(true))

    requests
      .get(`Bearer ${TOKEN_A}`)
      ?.resolve(response(batchEnvelope({ 'item-0': { translatedText: 'stale', cached: false } })))
    await act(async () => Promise.resolve())
    expect(result.current.translatedListPosts).toEqual({})

    requests
      .get(`Bearer ${TOKEN_B}`)
      ?.resolve(response(batchEnvelope({ 'item-0': { translatedText: 'fresh', cached: false } })))
    await waitFor(() =>
      expect(result.current.translatedListPosts[bodyOnlyPost.id]).toEqual({ body: 'fresh' })
    )
    expect(result.current.translatingList).toBe(false)
  })

  it('aborts and fails empty when the rendered owner is no longer ready', async () => {
    mockLanguage = 'ja'
    const bodyOnlyPost = { ...listPost, title: '' }
    const translation = deferred<Response>()
    let translationSignal: AbortSignal | undefined
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return new Promise(() => undefined)
      if (url === '/api/translate') {
        translationSignal = options?.signal
        return translation.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    let auth = authenticatedSession()
    mockUseAuthSession.mockImplementation(() => auth)
    const { result, rerender } = renderHook(() => useHotPageData({ initialPosts: [bodyOnlyPost] }))
    await waitFor(() => expect(result.current.translatingList).toBe(true))

    auth = { ...authenticatedSession(), isLoggedIn: false }
    rerender()
    await waitFor(() => expect(result.current.translatingList).toBe(false))
    expect(translationSignal?.aborted).toBe(true)
    expect(result.current.translatedListPosts).toEqual({})

    translation.resolve(
      response(batchEnvelope({ 'item-0': { translatedText: 'late private value', cached: false } }))
    )
    await act(async () => Promise.resolve())
    expect(result.current.translatedListPosts).toEqual({})
  })

  it('isolates a late list batch after the same post ID changes its exact source', async () => {
    mockLanguage = 'ja'
    const sourcePostId = '33333333-3333-4333-8333-333333333333'
    const initialPost = {
      ...listPost,
      id: sourcePostId,
      title: '',
      body: 'Original English body',
    }
    const changedBody = 'Changed English body with authoritative revision'
    const page = deferred<Response>()
    const requests = new Map<
      string,
      { pending: ReturnType<typeof deferred<Response>>; signal: AbortSignal | undefined }
    >()
    mockFetch.mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/posts')) return page.promise
      if (url === '/api/translate') {
        const body = requestBody(options)
        const pending = deferred<Response>()
        requests.set(body.items?.[0]?.text ?? '', { pending, signal: options?.signal })
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { result } = renderHook(() => useHotPageData({ initialPosts: [initialPost] }))
    await waitFor(() => expect(requests.has(initialPost.body)).toBe(true))

    page.resolve(
      response(
        postsPage([
          {
            ...rawHotPost,
            id: sourcePostId,
            title: '',
            content: changedBody,
          },
        ])
      )
    )
    await waitFor(() => expect(requests.has(changedBody)).toBe(true))
    expect(requests.get(initialPost.body)?.signal?.aborted).toBe(true)

    requests
      .get(initialPost.body)
      ?.pending.resolve(
        response(batchEnvelope({ 'item-0': { translatedText: 'stale source', cached: false } }))
      )
    await act(async () => Promise.resolve())
    expect(result.current.translatedListPosts).toEqual({})

    requests
      .get(changedBody)
      ?.pending.resolve(
        response(batchEnvelope({ 'item-0': { translatedText: 'fresh source', cached: false } }))
      )
    await waitFor(() =>
      expect(result.current.translatedListPosts[initialPost.id]).toEqual({ body: 'fresh source' })
    )
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
