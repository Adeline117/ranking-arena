import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import FlashNewsPageClient from '../FlashNewsPageClient'

const mockShowToast = jest.fn()
const mockUseAuthSession = jest.fn()
const mockT = (key: string) => key
let mockLanguage: 'zh' | 'en' | 'ja' | 'ko' = 'en'
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const accessTokenFor = (subject: string, revision: string) =>
  `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature-${revision}`
const TOKEN_A = accessTokenFor(USER_A, 'a')
const TOKEN_A_REFRESHED = accessTokenFor(USER_A, 'refreshed')
const TOKEN_B = accessTokenFor(USER_B, 'b')

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: mockLanguage, t: mockT }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-test' }),
}))

jest.mock('../components/NewsTimelineSkeleton', () => ({
  __esModule: true,
  default: () => <div data-testid="news-loading">Loading news</div>,
}))

jest.mock('../components/NewsCard', () => ({
  __esModule: true,
  default: ({
    item,
    getNewsContent,
    translatedContent,
  }: {
    item: { id: string }
    getNewsContent: (item: { id: string }) => string | null
    translatedContent: Record<string, string>
  }) => (
    <article data-testid={`news-${item.id}`} data-translated={Boolean(translatedContent[item.id])}>
      {getNewsContent(item)}
    </article>
  ),
}))

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

type NewsFixture = ReturnType<typeof newsItem>

function newsItem(id: string, content: string) {
  return {
    id,
    title: `Title ${id}`,
    source: 'Arena',
    category: 'market' as const,
    importance: 'normal' as const,
    tags: [],
    content,
    published_at: '2026-08-03T12:00:00.000Z',
    created_at: '2026-08-03T12:00:00.000Z',
  }
}

function newsPage(items: NewsFixture[], page = 1, hasNext = false) {
  return {
    success: true,
    data: {
      news: items,
      pagination: {
        page,
        limit: 20,
        total: items.length,
        totalPages: hasNext ? 2 : page,
        hasNext,
        hasPrev: page > 1,
      },
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

function parsedBody(options?: RequestInit) {
  return JSON.parse(options?.body as string) as {
    targetLang: 'zh' | 'en' | 'ja' | 'ko'
    items: Array<{
      id: string
      text: string
      contentType: string
      contentId: string
    }>
  }
}

function translatedEnvelope(
  body: ReturnType<typeof parsedBody>,
  prefix = 'translated'
): ReturnType<typeof batchEnvelope> {
  return batchEnvelope(
    Object.fromEntries(
      body.items.map((item) => [item.id, { translatedText: `${prefix}-${item.id}`, cached: false }])
    )
  )
}

function itemTranslationState(id: string): HTMLElement {
  const element = screen.getByTestId(`news-${id}`).parentElement
  if (!element) throw new Error(`Missing translation state container for ${id}`)
  return element
}

function authenticatedSession(token = TOKEN_A, userId = USER_A, sessionGeneration = 4) {
  return {
    authChecked: true,
    isLoggedIn: true,
    accessToken: token,
    userId,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  }
}

let intersectionCallbacks: IntersectionObserverCallback[] = []

class MockIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds = []

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallbacks.push(callback)
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

describe('FlashNewsPageClient translation truth', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    intersectionCallbacks = []
    mockLanguage = 'en'
    mockUseAuthSession.mockReturnValue(authenticatedSession())
    window.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof window.IntersectionObserver
  })

  afterEach(() => {
    jest.useRealTimers()
    if (originalFetch) globalThis.fetch = originalFetch
    else Reflect.deleteProperty(globalThis, 'fetch')
  })

  it('exposes truthful busy/disabled state on a 44px reachable control', async () => {
    const pageRequest = deferred<Response>()
    globalThis.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return pageRequest.promise
      throw new Error(`Unexpected request: ${url}`)
    }) as never

    render(<FlashNewsPageClient />)

    const breakingButton = screen.getByRole('button', { name: 'newsFlash_imp_breaking' })
    expect(breakingButton).toBeDisabled()
    expect(breakingButton).toHaveAttribute('aria-busy', 'true')
    expect(breakingButton).toHaveStyle({ minHeight: '44px' })
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'true')

    pageRequest.resolve(response(newsPage([])))
    await waitFor(() => expect(breakingButton).not.toBeDisabled())
    expect(breakingButton).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
  })

  it('binds a complete Japanese batch to full source text and flash-news identity', async () => {
    mockLanguage = 'ja'
    const source = `Full source: ${'x'.repeat(640)}`
    const item = newsItem('news-1', source)
    let translationRequest: ReturnType<typeof parsedBody> | undefined
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') {
        translationRequest = parsedBody(options)
        return Promise.resolve(
          response(
            batchEnvelope({
              'news-1': { translatedText: '完全な日本語翻訳', cached: false },
            })
          )
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never

    render(<FlashNewsPageClient />)

    expect(await screen.findByText('完全な日本語翻訳')).toBeInTheDocument()
    expect(translationRequest).toMatchObject({ targetLang: 'ja' })
    expect(translationRequest?.items).toEqual([
      { id: item.id, text: source, contentType: 'flash_news', contentId: item.id },
    ])
    expect(screen.getByTestId('news-news-1')).toHaveAttribute('data-translated', 'true')
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
    const breakingButton = screen.getByRole('button', { name: 'newsFlash_imp_breaking' })
    expect(breakingButton).not.toBeDisabled()
    expect(breakingButton).toHaveStyle({ minHeight: '44px' })
  })

  it.each([
    ['JWT subject differs from the user', { accessToken: TOKEN_B }],
    ['viewer key differs from the user', { viewerKey: `user:${USER_B}` }],
    ['authentication is not checked', { authChecked: false }],
    ['session generation is negative', { sessionGeneration: -1 }],
    ['session generation is not a safe integer', { sessionGeneration: 1.5 }],
  ])('does not use a bearer token when %s', async (_label, override) => {
    const item = newsItem('news-1', '身份范围不完整时保留原文')
    mockUseAuthSession.mockReturnValue({ ...authenticatedSession(), ...override })
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') throw new Error('Invalid viewer scope must not translate')
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never

    render(<FlashNewsPageClient />)

    expect(await screen.findByText(item.content)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
    )
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/translate')).toBe(false)
    expect(itemTranslationState(item.id)).toHaveAttribute('aria-busy', 'false')
  })

  it.each([
    ['partial result', (item: NewsFixture) => batchEnvelope({}, 1)],
    [
      'original echo',
      (item: NewsFixture) =>
        batchEnvelope({ [item.id]: { translatedText: item.content, cached: true } }),
    ],
  ])('keeps original content and releases busy state for a %s', async (_label, payload) => {
    const item = newsItem('news-1', '需要翻译的内容')
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') return Promise.resolve(response(payload(item)))
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never

    render(<FlashNewsPageClient />)

    expect(await screen.findByText(item.content)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
    )
    expect(screen.getByTestId(`news-${item.id}`)).toHaveAttribute('data-translated', 'false')
  })

  it('translates the complete list in bounded batches and publishes all batches atomically', async () => {
    const items = Array.from({ length: 21 }, (_, index) =>
      newsItem(`news-${index}`, `complete-source-${index}-${'x'.repeat(80)}`)
    )
    const requests: Array<{
      body: ReturnType<typeof parsedBody>
      pending: ReturnType<typeof deferred<Response>>
    }> = []
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage(items)))
      if (url === '/api/translate') {
        const request = { body: parsedBody(options), pending: deferred<Response>() }
        requests.push(request)
        return request.pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never

    render(<FlashNewsPageClient />)

    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.map(({ body }) => body.items.length)).toEqual([20, 1])
    const outgoingItems = requests.flatMap(({ body }) => body.items)
    expect(outgoingItems).toHaveLength(21)
    expect(outgoingItems).toEqual(
      items.map((item) => ({
        id: item.id,
        text: item.content,
        contentType: 'flash_news',
        contentId: item.id,
      }))
    )
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'true')
    expect(itemTranslationState(items[0].id)).toHaveAttribute('aria-busy', 'true')
    expect(itemTranslationState(items[20].id)).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      requests[0].pending.resolve(response(translatedEnvelope(requests[0].body)))
      await requests[0].pending.promise
      await Promise.resolve()
    })
    expect(screen.queryByText('translated-news-0')).not.toBeInTheDocument()
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'true')
    expect(itemTranslationState(items[0].id)).toHaveAttribute('aria-busy', 'true')

    requests[1].pending.resolve(response(translatedEnvelope(requests[1].body)))
    expect(await screen.findByText('translated-news-0')).toBeInTheDocument()
    expect(await screen.findByText('translated-news-20')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
    )
    expect(itemTranslationState(items[0].id)).toHaveAttribute('aria-busy', 'false')
    expect(itemTranslationState(items[20].id)).toHaveAttribute('aria-busy', 'false')
  })

  it('aborts pending sibling batches and publishes nothing when any batch fails', async () => {
    const items = Array.from({ length: 41 }, (_, index) =>
      newsItem(`news-${index}`, `failure-source-${index}`)
    )
    const requests: Array<{
      body: ReturnType<typeof parsedBody>
      pending: ReturnType<typeof deferred<Response>>
      signal: AbortSignal
    }> = []
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage(items)))
      if (url === '/api/translate') {
        const request = {
          body: parsedBody(options),
          pending: deferred<Response>(),
          signal: options?.signal as AbortSignal,
        }
        requests.push(request)
        return request.pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never

    render(<FlashNewsPageClient />)

    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests.map(({ body }) => body.items.length)).toEqual([20, 20, 1])
    expect(itemTranslationState(items[40].id)).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      requests[0].pending.resolve(response(translatedEnvelope(requests[0].body, 'first-batch')))
      await requests[0].pending.promise
      await Promise.resolve()
    })
    expect(screen.queryByText('first-batch-news-0')).not.toBeInTheDocument()
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'true')

    requests[1].pending.resolve(response(batchEnvelope({}, requests[1].body.items.length)))
    await waitFor(() => expect(requests[2].signal.aborted).toBe(true))
    await waitFor(() =>
      expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
    )
    expect(screen.queryByText('first-batch-news-0')).not.toBeInTheDocument()
    expect(screen.getByText(items[0].content)).toBeInTheDocument()
    expect(screen.getByText(items[40].content)).toBeInTheDocument()
    expect(itemTranslationState(items[0].id)).toHaveAttribute('aria-busy', 'false')
    expect(itemTranslationState(items[40].id)).toHaveAttribute('aria-busy', 'false')

    requests[2].pending.resolve(response(translatedEnvelope(requests[2].body, 'late-sibling')))
    await act(async () => {
      await requests[2].pending.promise
      await Promise.resolve()
    })
    expect(screen.queryByText('late-sibling-news-40')).not.toBeInTheDocument()
  })

  it('physically releases translation busy when fetch ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const item = newsItem('news-1', '超时原文')
    let translationCalls = 0
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') {
        translationCalls += 1
        return new Promise(() => undefined)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never

    render(<FlashNewsPageClient />)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(translationCalls).toBe(1)
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
    })
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByText(item.content)).toBeInTheDocument()
  })

  it('rejects a late response after a same-viewer token refresh', async () => {
    const item = newsItem('news-1', '身份范围原文')
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') {
        const authorization = (options?.headers as Record<string, string>).Authorization
        const pending = deferred<Response>()
        requests.set(authorization, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never
    const { rerender } = render(<FlashNewsPageClient />)
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_A}`)).toBe(true))

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_A_REFRESHED))
    rerender(<FlashNewsPageClient />)
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_A_REFRESHED}`)).toBe(true))

    requests
      .get(`Bearer ${TOKEN_A}`)
      ?.resolve(
        response(batchEnvelope({ [item.id]: { translatedText: 'stale-token', cached: false } }))
      )
    await act(async () => Promise.resolve())
    expect(screen.queryByText('stale-token')).not.toBeInTheDocument()
    expect(screen.getByText(item.content)).toBeInTheDocument()

    requests
      .get(`Bearer ${TOKEN_A_REFRESHED}`)
      ?.resolve(
        response(batchEnvelope({ [item.id]: { translatedText: 'fresh-token', cached: false } }))
      )
    expect(await screen.findByText('fresh-token')).toBeInTheDocument()
  })

  it('rejects a late batch after the viewer session changes', async () => {
    mockLanguage = 'ja'
    const item = newsItem('news-1', 'Cross-scope source')
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') {
        const body = parsedBody(options)
        const authorization = (options?.headers as Record<string, string>).Authorization
        const pending = deferred<Response>()
        requests.set(`${authorization}:${body.targetLang}`, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never
    const { rerender } = render(<FlashNewsPageClient />)
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_A}:ja`)).toBe(true))

    mockUseAuthSession.mockReturnValue(authenticatedSession(TOKEN_B, USER_B, 5))
    rerender(<FlashNewsPageClient />)
    await waitFor(() => expect(requests.has(`Bearer ${TOKEN_B}:ja`)).toBe(true))

    requests
      .get(`Bearer ${TOKEN_A}:ja`)
      ?.resolve(
        response(batchEnvelope({ [item.id]: { translatedText: 'stale-japanese', cached: false } }))
      )
    await act(async () => Promise.resolve())
    expect(screen.queryByText('stale-japanese')).not.toBeInTheDocument()
    expect(screen.getByText(item.content)).toBeInTheDocument()

    requests
      .get(`Bearer ${TOKEN_B}:ja`)
      ?.resolve(
        response(batchEnvelope({ [item.id]: { translatedText: 'fresh-viewer', cached: false } }))
      )
    expect(await screen.findByText('fresh-viewer')).toBeInTheDocument()
  })

  it('rejects a late batch after only the target language changes', async () => {
    mockLanguage = 'ja'
    const item = newsItem('news-1', 'Language-scope source')
    const requests = new Map<string, ReturnType<typeof deferred<Response>>>()
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) return Promise.resolve(response(newsPage([item])))
      if (url === '/api/translate') {
        const pending = deferred<Response>()
        requests.set(parsedBody(options).targetLang, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never
    const { rerender } = render(<FlashNewsPageClient />)
    await waitFor(() => expect(requests.has('ja')).toBe(true))

    mockLanguage = 'ko'
    rerender(<FlashNewsPageClient />)
    await waitFor(() => expect(requests.has('ko')).toBe(true))

    requests
      .get('ja')
      ?.resolve(
        response(batchEnvelope({ [item.id]: { translatedText: 'stale-language', cached: false } }))
      )
    await act(async () => Promise.resolve())
    expect(screen.queryByText('stale-language')).not.toBeInTheDocument()
    expect(screen.getByText(item.content)).toBeInTheDocument()

    requests
      .get('ko')
      ?.resolve(
        response(batchEnvelope({ [item.id]: { translatedText: 'fresh-language', cached: false } }))
      )
    expect(await screen.findByText('fresh-language')).toBeInTheDocument()
  })

  it('rejects old source content and keeps last-good only for the active item source', async () => {
    const first = newsItem('news-1', '第一版原文')
    const second = newsItem('news-1', '第二版原文')
    const translationRequests = new Map<string, ReturnType<typeof deferred<Response>>>()
    let listRequest = 0
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) {
        listRequest += 1
        return Promise.resolve(response(newsPage([listRequest === 1 ? first : second])))
      }
      if (url === '/api/translate') {
        const body = parsedBody(options)
        const pending = deferred<Response>()
        translationRequests.set(body.items[0].text, pending)
        return pending.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never
    render(<FlashNewsPageClient />)
    await waitFor(() => expect(translationRequests.has(first.content)).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'newsFlash_cat_btc_eth' }))
    await waitFor(() => expect(translationRequests.has(second.content)).toBe(true))

    translationRequests
      .get(first.content)
      ?.resolve(
        response(batchEnvelope({ [first.id]: { translatedText: 'stale-source', cached: false } }))
      )
    await act(async () => Promise.resolve())
    expect(screen.queryByText('stale-source')).not.toBeInTheDocument()
    expect(screen.getByText(second.content)).toBeInTheDocument()

    translationRequests
      .get(second.content)
      ?.resolve(
        response(batchEnvelope({ [second.id]: { translatedText: 'fresh-source', cached: false } }))
      )
    expect(await screen.findByText('fresh-source')).toBeInTheDocument()
  })

  it('single-flights an in-flight source key when pagination creates an equivalent news array', async () => {
    const firstPage = Array.from({ length: 6 }, (_, index) =>
      newsItem(`news-${index}`, `source-${index}`)
    )
    const translation = deferred<Response>()
    let translationCalls = 0
    let translationBody: ReturnType<typeof parsedBody> | undefined
    let translationSignal: AbortSignal | undefined
    const fetchMock = jest.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/flash-news')) {
        const page = new URL(url, 'https://arena.local').searchParams.get('page')
        return Promise.resolve(
          response(page === '2' ? newsPage([firstPage[0]], 2, false) : newsPage(firstPage, 1, true))
        )
      }
      if (url === '/api/translate') {
        translationCalls += 1
        translationBody = parsedBody(options)
        translationSignal = options?.signal as AbortSignal
        return translation.promise
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    globalThis.fetch = fetchMock as never
    render(<FlashNewsPageClient />)
    await waitFor(() => expect(translationCalls).toBe(1))
    await waitFor(() => expect(intersectionCallbacks.length).toBeGreaterThan(0))

    await act(async () => {
      intersectionCallbacks.at(-1)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(await screen.findByText('flashNewsTotal')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'true')
    )
    expect(translationCalls).toBe(1)
    expect(translationSignal?.aborted).toBe(false)
    expect(translationBody?.items).toHaveLength(6)

    if (!translationBody) throw new Error('Missing translation request')
    translation.resolve(response(translatedEnvelope(translationBody)))
    expect(await screen.findByText('translated-news-0')).toBeInTheDocument()
    expect(await screen.findByText('translated-news-5')).toBeInTheDocument()
    expect(screen.getByTestId('flash-news-timeline')).toHaveAttribute('aria-busy', 'false')
  })
})
