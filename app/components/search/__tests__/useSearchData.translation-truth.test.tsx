import { act, renderHook, waitFor } from '@testing-library/react'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import type { Language } from '@/lib/i18n'
import { useSearchData } from '../useSearchData'

const mockUseAuthSession = jest.fn()
const mockLoggerError = jest.fn()
const mockGetCsrfHeaders = jest.fn(() => ({ 'x-csrf-token': 'csrf-search' }))
let mockLanguage: Language = 'ja'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: mockLanguage,
    t: (key: string) => (key === 'noTitle' ? `no-title-${mockLanguage}` : key),
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => mockGetCsrfHeaders(),
}))

jest.mock('@/lib/services/search-history', () => ({
  initializeHistory: jest.fn().mockResolvedValue([]),
  addToHistory: jest.fn().mockResolvedValue([]),
  removeFromHistory: jest.fn().mockResolvedValue([]),
  clearHistory: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

jest.mock('@/lib/features', () => ({ features: { social: true } }))

type TranslationBody = {
  targetLang: Language
  items: Array<{
    id: string
    text: string
    contentType: string
    contentId: string
  }>
}

type TranslationRequest = {
  body: TranslationBody
  options: RequestInit
  pending: ReturnType<typeof deferred<Response>>
}

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const accessTokenFor = (subject: string, revision: string) =>
  `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature-${revision}`
const TOKEN_A = accessTokenFor(USER_A, 'a')
const TOKEN_B = accessTokenFor(USER_A, 'b')
const TOKEN_B_VIEWER = accessTokenFor(USER_B, 'c')

function authenticatedSession(accessToken = TOKEN_A, sessionGeneration = 1, userId = USER_A) {
  return {
    userId,
    isLoggedIn: true,
    authChecked: true,
    accessToken,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  }
}

function rawPost(id = 'post-1', title: string | null = 'English title', content?: string) {
  return {
    id,
    title,
    content,
    hot_score: 42,
    view_count: 10,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(body: unknown, json?: () => Promise<unknown>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: json ?? (async () => body),
  } as Response
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

function translationBody(options?: RequestInit): TranslationBody {
  return JSON.parse(options?.body as string) as TranslationBody
}

function installFetch(
  posts: () => ReturnType<typeof rawPost>[],
  translate: (options: RequestInit) => Promise<Response>
) {
  const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const url = String(input)
    if (url === '/api/search?type=trending') {
      return Promise.resolve(response({ data: { trending: [], fallback: [] } }))
    }
    if (url.startsWith('/api/posts?')) {
      return Promise.resolve(response({ data: { posts: posts() } }))
    }
    if (url === '/api/translate') return translate(options ?? {})
    if (url.startsWith('/api/search?q=')) {
      return Promise.resolve(
        response({
          query: '',
          total: 0,
          results: { traders: [], posts: [], users: [], groups: [] },
        })
      )
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  globalThis.fetch = fetchMock as never
  return fetchMock
}

function pendingTranslationFetch(posts: () => ReturnType<typeof rawPost>[]) {
  const requests: TranslationRequest[] = []
  const fetchMock = installFetch(posts, (options) => {
    const pending = deferred<Response>()
    requests.push({ body: translationBody(options), options, pending })
    return pending.promise
  })
  return { fetchMock, requests }
}

describe('useSearchData translation truth', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    mockLanguage = 'ja'
    mockUseAuthSession.mockReturnValue(authenticatedSession())
  })

  afterEach(() => {
    jest.useRealTimers()
    if (originalFetch) globalThis.fetch = originalFetch
    else Reflect.deleteProperty(globalThis, 'fetch')
  })

  it.each([
    ['ja' as const, '完全な日本語訳'],
    ['ko' as const, '완전한 한국어 번역'],
  ])(
    'sends the complete source and publishes a strict %s receipt',
    async (targetLang, translated) => {
      mockLanguage = targetLang
      const source = `# Full source ${'x'.repeat(640)} **without truncation**`
      const posts = [rawPost('post-1', 'Untitled', source)]
      let capturedBody: TranslationBody | undefined
      let capturedOptions: RequestInit | undefined
      const fetchMock = installFetch(
        () => posts,
        async (options) => {
          capturedBody = translationBody(options)
          capturedOptions = options
          return response(
            batchEnvelope({ 'post-1': { translatedText: translated, cached: false } })
          )
        }
      )

      const { result } = renderHook(() => useSearchData(true, ''))

      await waitFor(() =>
        expect(result.current.translatedTitles[`${targetLang}:post-1`]).toBe(translated)
      )
      expect(result.current.hotPosts[0].title).not.toBe(source)
      expect(capturedBody).toEqual({
        targetLang,
        items: [
          {
            id: 'post-1',
            text: source,
            contentType: 'post_title',
            contentId: 'post-1',
          },
        ],
      })
      expect(capturedOptions).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
          'x-csrf-token': 'csrf-search',
        },
      })
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input) === '/api/translate')
      ).toHaveLength(1)
      expect(result.current.translating).toBe(false)
    }
  )

  it('sends majority-English mixed-script text instead of hiding the foreign fragment', async () => {
    mockLanguage = 'en'
    const source = 'Trading markets rallied sharply after the open 거래 속보'
    let capturedBody: TranslationBody | undefined
    installFetch(
      () => [rawPost('mixed-post', 'Untitled', source)],
      async (options) => {
        capturedBody = translationBody(options)
        return response(
          batchEnvelope({
            'mixed-post': {
              translatedText: 'Trading markets rallied after breaking news',
              cached: false,
            },
          })
        )
      }
    )

    const { result } = renderHook(() => useSearchData(true, ''))

    await waitFor(() =>
      expect(result.current.translatedTitles['en:mixed-post']).toBe(
        'Trading markets rallied after breaking news'
      )
    )
    expect(capturedBody?.items).toEqual([
      {
        id: 'mixed-post',
        text: source,
        contentType: 'post_title',
        contentId: 'mixed-post',
      },
    ])
  })

  it('fails closed when the bearer identity does not match the committed viewer', async () => {
    mockUseAuthSession.mockReturnValue({
      ...authenticatedSession(),
      viewerKey: `user:${USER_B}`,
    })
    let translationCalls = 0
    installFetch(
      () => [rawPost()],
      async () => {
        translationCalls += 1
        return response(
          batchEnvelope({ 'post-1': { translatedText: 'must not publish', cached: false } })
        )
      }
    )

    const { result } = renderHook(() => useSearchData(true, ''))
    await waitFor(() => expect(result.current.hotPosts).toHaveLength(1))

    expect(translationCalls).toBe(0)
    expect(result.current.translating).toBe(false)
    expect(result.current.translatedTitles).toEqual({})
  })

  it('fails closed when the bearer subject does not match the rendered user', async () => {
    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B_VIEWER, 1, USER_A))
    let translationCalls = 0
    installFetch(
      () => [rawPost()],
      async () => {
        translationCalls += 1
        return response(
          batchEnvelope({ 'post-1': { translatedText: 'must not publish', cached: false } })
        )
      }
    )

    const { result } = renderHook(() => useSearchData(true, ''))
    await waitFor(() => expect(result.current.hotPosts).toHaveLength(1))

    expect(translationCalls).toBe(0)
    expect(result.current.translating).toBe(false)
    expect(result.current.translatedTitles).toEqual({})
  })

  it('reuses exact same-user translation cache after a token refresh', async () => {
    let auth = authenticatedSession()
    mockUseAuthSession.mockImplementation(() => auth)
    let translationCalls = 0
    installFetch(
      () => [rawPost()],
      async () => {
        translationCalls += 1
        return response(
          batchEnvelope({ 'post-1': { translatedText: 'cached translation', cached: false } })
        )
      }
    )

    const { result, rerender } = renderHook(() => useSearchData(true, ''))
    await waitFor(() =>
      expect(result.current.translatedTitles['ja:post-1']).toBe('cached translation')
    )

    auth = authenticatedSession(TOKEN_B)
    rerender()

    await waitFor(() => expect(result.current.translating).toBe(false))
    expect(translationCalls).toBe(1)
    expect(result.current.translatedTitles['ja:post-1']).toBe('cached translation')
  })

  it('aborts old hot-post loads and ignores their data and finally after reopen', async () => {
    mockUseAuthSession.mockReturnValue({
      ...authenticatedSession(),
      viewerKey: `user:${USER_B}`,
    })
    const postRequests: Array<{
      options: RequestInit
      pending: ReturnType<typeof deferred<Response>>
    }> = []
    globalThis.fetch = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url === '/api/search?type=trending') {
        return Promise.resolve(response({ data: { trending: [], fallback: [] } }))
      }
      if (url.startsWith('/api/posts?')) {
        const pending = deferred<Response>()
        postRequests.push({ options: options ?? {}, pending })
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as never
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useSearchData(open, ''),
      { initialProps: { open: true } }
    )

    await waitFor(() => expect(postRequests).toHaveLength(1))
    expect(result.current.loading).toBe(true)
    rerender({ open: false })
    expect(postRequests[0].options.signal?.aborted).toBe(true)
    expect(result.current.loading).toBe(false)

    rerender({ open: true })
    await waitFor(() => expect(postRequests).toHaveLength(2))
    expect(result.current.loading).toBe(true)

    postRequests[0].pending.resolve(response({ data: { posts: [rawPost('post-a', 'Old A')] } }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.hotPosts).toEqual([])
    expect(result.current.loading).toBe(true)

    postRequests[1].pending.resolve(response({ data: { posts: [rawPost('post-b', 'Current B')] } }))
    await waitFor(() => expect(result.current.hotPosts[0]?.title).toBe('Current B'))
    expect(result.current.loading).toBe(false)
  })

  it('remaps no-source fallback immediately on language change and aborts the refresh on unmount', async () => {
    const secondPostRequest = deferred<Response>()
    const postOptions: RequestInit[] = []
    globalThis.fetch = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url === '/api/search?type=trending') {
        return Promise.resolve(response({ data: { trending: [], fallback: [] } }))
      }
      if (url.startsWith('/api/posts?')) {
        postOptions.push(options ?? {})
        if (postOptions.length === 1) {
          return Promise.resolve(response({ data: { posts: [rawPost('post-1', null)] } }))
        }
        return secondPostRequest.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as never
    const { result, rerender, unmount } = renderHook(() => useSearchData(true, ''))

    await waitFor(() => expect(result.current.hotPosts[0]?.title).toBe('no-title-ja'))
    mockLanguage = 'ko'
    rerender()

    expect(result.current.hotPosts[0]?.title).toBe('no-title-ko')
    await waitFor(() => expect(postOptions).toHaveLength(2))
    expect(result.current.loading).toBe(true)
    unmount()
    expect(postOptions[1].signal?.aborted).toBe(true)
  })

  it.each([
    ['zh' as const, '日本語の市場速報', '中文译文'],
    ['en' as const, '한국어 시장 속보', 'Korean market bulletin'],
  ])('does not misclassify ja/ko source text as target %s', async (target, source, translated) => {
    mockLanguage = target
    let translationCalls = 0
    installFetch(
      () => [rawPost('post-1', source)],
      async () => {
        translationCalls += 1
        return response(batchEnvelope({ 'post-1': { translatedText: translated, cached: false } }))
      }
    )

    const { result } = renderHook(() => useSearchData(true, ''))
    await waitFor(() =>
      expect(result.current.translatedTitles[`${target}:post-1`]).toBe(translated)
    )
    expect(translationCalls).toBe(1)
  })

  it.each([
    [
      'partial result',
      (source: string) => ({
        success: true,
        data: { results: {}, total: 1, cached: 0, translated: 1 },
      }),
    ],
    [
      'extra result',
      (source: string) =>
        batchEnvelope(
          {
            'post-1': { translatedText: '有効な翻訳', cached: false },
            injected: { translatedText: source, cached: false },
          },
          1
        ),
    ],
    [
      'original echo',
      (source: string) => batchEnvelope({ 'post-1': { translatedText: source, cached: true } }),
    ],
  ])('fails empty and releases loading for a %s', async (_label, payload) => {
    const source = 'English source that requires Japanese translation'
    let translationCalls = 0
    installFetch(
      () => [rawPost('post-1', source)],
      async () => {
        translationCalls += 1
        return response(payload(source))
      }
    )
    const { result } = renderHook(() => useSearchData(true, ''))

    await waitFor(() => expect(translationCalls).toBe(1))
    await waitFor(() => expect(result.current.translating).toBe(false))
    expect(result.current.translatedTitles).toEqual({})
    expect(result.current.hotPosts[0].title).toBe(source)
  })

  it.each(['fetch', 'json'] as const)(
    'physically releases loading after the 15s %s deadline is ignored',
    async (stalledPhase) => {
      jest.useFakeTimers()
      let translationSignal: AbortSignal | null = null
      let translationCalls = 0
      installFetch(
        () => [rawPost()],
        (options) => {
          translationCalls += 1
          translationSignal = options.signal as AbortSignal
          if (stalledPhase === 'fetch') return new Promise<Response>(() => undefined)
          return Promise.resolve(response(null, () => new Promise<unknown>(() => undefined)))
        }
      )
      const { result } = renderHook(() => useSearchData(true, ''))

      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(translationCalls).toBe(1)
      expect(result.current.translating).toBe(true)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
      })
      expect(result.current.translating).toBe(false)
      expect(result.current.translatedTitles).toEqual({})
      expect(translationSignal?.aborted).toBe(true)
    }
  )

  it('single-flights identical work and isolates viewer/session/token/language/query changes', async () => {
    const posts = [rawPost()]
    const { requests } = pendingTranslationFetch(() => posts)
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useSearchData(true, query),
      { initialProps: { query: '' } }
    )

    await waitFor(() => expect(requests).toHaveLength(1))
    rerender({ query: '' })
    rerender({ query: '' })
    expect(requests).toHaveLength(1)

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B))
    rerender({ query: '' })
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0].options.signal?.aborted).toBe(true)

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B, 2))
    rerender({ query: '' })
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[1].options.signal?.aborted).toBe(true)

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B_VIEWER, 3, USER_B))
    rerender({ query: '' })
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[2].options.signal?.aborted).toBe(true)

    mockLanguage = 'ko'
    rerender({ query: '' })
    await waitFor(() => expect(requests).toHaveLength(5))
    expect(requests[3].options.signal?.aborted).toBe(true)

    rerender({ query: 'a' })
    await waitFor(() => expect(requests).toHaveLength(6))
    expect(requests[4].options.signal?.aborted).toBe(true)
    expect(result.current.translatedTitles).toEqual({})

    await act(async () => {
      requests.slice(0, 5).forEach((request, index) => {
        request.pending.resolve(
          response(
            batchEnvelope({
              'post-1': { translatedText: `stale-${index}`, cached: false },
            })
          )
        )
      })
      await Promise.resolve()
    })
    expect(result.current.translatedTitles).toEqual({})
    expect(result.current.translating).toBe(true)

    requests[5].pending.resolve(
      response(batchEnvelope({ 'post-1': { translatedText: '최종 번역', cached: false } }))
    )
    await waitFor(() => expect(result.current.translatedTitles['ko:post-1']).toBe('최종 번역'))
    expect(requests[5].body.targetLang).toBe('ko')
    expect(requests[5].options.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN_B_VIEWER}`,
    })
    expect(result.current.translating).toBe(false)
  })

  it('rejects late work after a same-id full source revision', async () => {
    let posts = [rawPost('post-1', 'Old source')]
    const { requests } = pendingTranslationFetch(() => posts)
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useSearchData(open, ''),
      { initialProps: { open: true } }
    )

    await waitFor(() =>
      expect(requests.some((request) => request.body.items[0].id === 'post-1')).toBe(true)
    )
    rerender({ open: false })
    expect(result.current.translating).toBe(false)
    expect(requests[0].options.signal?.aborted).toBe(true)

    posts = [rawPost('post-1', 'New source revision')]
    rerender({ open: true })
    await waitFor(() =>
      expect(requests.some((request) => request.body.items[0].text === 'New source revision')).toBe(
        true
      )
    )

    const oldRequests = requests.filter((request) => request.body.items[0].text === 'Old source')
    const newRequest = requests.find(
      (request) => request.body.items[0].text === 'New source revision'
    )
    expect(newRequest).toBeDefined()

    await act(async () => {
      oldRequests.forEach((request) => {
        request.pending.resolve(
          response(batchEnvelope({ 'post-1': { translatedText: '古い翻訳', cached: false } }))
        )
      })
      await Promise.resolve()
    })
    expect(result.current.translatedTitles).toEqual({})

    newRequest!.pending.resolve(
      response(batchEnvelope({ 'post-1': { translatedText: '新しい翻訳', cached: false } }))
    )
    await waitFor(() => expect(result.current.translatedTitles['ja:post-1']).toBe('新しい翻訳'))
  })

  it('restores only the exact same-scope last-good result after cancellation', async () => {
    const laterRequest = deferred<Response>()
    let translationCalls = 0
    let laterSignal: AbortSignal | undefined
    installFetch(
      () => [rawPost()],
      (options) => {
        translationCalls += 1
        if (translationCalls === 1) {
          return Promise.resolve(
            response(
              batchEnvelope({ 'post-1': { translatedText: '最後の正常結果', cached: false } })
            )
          )
        }
        laterSignal = options.signal
        return laterRequest.promise
      }
    )
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useSearchData(true, query),
      { initialProps: { query: '' } }
    )

    await waitFor(() => expect(result.current.translatedTitles['ja:post-1']).toBe('最後の正常結果'))
    rerender({ query: 'a' })
    await waitFor(() => expect(translationCalls).toBe(2))
    expect(result.current.translatedTitles).toEqual({})

    rerender({ query: '' })
    expect(laterSignal?.aborted).toBe(true)
    await waitFor(() => expect(result.current.translatedTitles['ja:post-1']).toBe('最後の正常結果'))
    expect(translationCalls).toBe(2)
    expect(result.current.translating).toBe(false)
  })

  it('aborts pending translation on unmount', async () => {
    const { requests } = pendingTranslationFetch(() => [rawPost()])
    const { unmount } = renderHook(() => useSearchData(true, ''))

    await waitFor(() => expect(requests).toHaveLength(1))
    unmount()
    expect(requests[0].options.signal?.aborted).toBe(true)

    requests[0].pending.resolve(
      response(batchEnvelope({ 'post-1': { translatedText: 'late', cached: false } }))
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockLoggerError).not.toHaveBeenCalled()
  })
})
