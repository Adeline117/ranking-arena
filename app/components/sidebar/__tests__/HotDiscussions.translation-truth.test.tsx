import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Language } from '@/lib/i18n'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import HotDiscussions from '../HotDiscussions'

type MockAuth = {
  userId: string | null
  isLoggedIn: boolean
  authChecked: boolean
  accessToken: string | null
  viewerKey: 'anon' | 'pending' | `user:${string}`
  sessionGeneration: number
}

type SourcePost = {
  id: string
  title: string | null
  content: string
  hot_score: number
  like_count: number
  comment_count: number
  created_at: string
  author_handle: string | null
  author_avatar_url: string | null
}

type TranslationBody = {
  targetLang: Language
  items: Array<{
    id: string
    text: string
    contentType: 'post_title' | 'post_content'
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
const mockUseAuthSession = jest.fn()
const postsQuery = jest.fn()
const querySignals: AbortSignal[] = []
let mockLanguage: Language = 'ja'
let mockDeferredReady = true

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query')
  return {
    ...actual,
    useQuery: (options: Record<string, unknown>) => actual.useQuery({ ...options, retry: false }),
  }
})

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/lib/hooks/useDeferredKey', () => ({
  useDeferredKey: () => (mockDeferredReady ? true : null),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-sidebar' }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: mockLanguage,
    t: (key: string) =>
      (
        ({
          sidebarHotDiscussions: 'Hot Discussions',
          sidebarNoDiscussions: 'No discussions',
          hotDiscussionsTagHot: 'Hot',
          hotDiscussionsTagRising: 'Rising',
          hotDiscussionsTagActive: 'Active',
          hotTranslatedBadge: 'TR',
          translating: 'Translating',
          loadFailed: 'Failed to load',
          retry: 'Retry',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        gt: jest.fn(() => ({
          eq: jest.fn(() => ({
            order: jest.fn(() => ({
              limit: jest.fn(() => ({
                abortSignal: (signal: AbortSignal) => {
                  querySignals.push(signal)
                  return postsQuery(signal)
                },
              })),
            })),
          })),
        })),
      })),
    })),
  },
}))

jest.mock('../SidebarCard', () => ({
  __esModule: true,
  default: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-testid="hot-discussions" aria-label={title}>
      {children}
    </section>
  ),
}))

function authenticatedSession(
  accessToken = TOKEN_A,
  sessionGeneration = 1,
  userId = USER_A
): MockAuth {
  return {
    userId,
    isLoggedIn: true,
    authChecked: true,
    accessToken,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  }
}

function rawPost(overrides: Partial<SourcePost> = {}): SourcePost {
  return {
    id: 'post-1',
    title: 'Original English title',
    content: 'Original English content',
    hot_score: 42,
    like_count: 3,
    comment_count: 2,
    created_at: '2026-08-03T00:00:00.000Z',
    author_handle: null,
    author_avatar_url: null,
    ...overrides,
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

function translationBody(options?: RequestInit): TranslationBody {
  return JSON.parse(options?.body as string) as TranslationBody
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

function translatedEnvelope(body: TranslationBody, prefix: string) {
  return batchEnvelope(
    Object.fromEntries(
      body.items.map((item) => [
        item.id,
        { translatedText: `${prefix}-${item.contentType}`, cached: false },
      ])
    )
  )
}

function installPendingTranslations(): TranslationRequest[] {
  const requests: TranslationRequest[] = []
  globalThis.fetch = jest.fn((_input: RequestInfo | URL, options?: RequestInit) => {
    const pending = deferred<Response>()
    requests.push({ body: translationBody(options), options: options ?? {}, pending })
    return pending.promise
  }) as typeof fetch
  return requests
}

function busyRegion(): HTMLElement {
  return screen.getByTestId('hot-discussions').querySelector<HTMLElement>('[aria-busy]')!
}

const queryClients: QueryClient[] = []

function renderWidget(limit = 8) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  queryClients.push(queryClient)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <HotDiscussions limit={limit} />
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

describe('HotDiscussions translation truth', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    jest.clearAllMocks()
    postsQuery.mockReset()
    querySignals.length = 0
    mockLanguage = 'ja'
    mockDeferredReady = true
    mockUseAuthSession.mockReturnValue(authenticatedSession())
  })

  afterEach(() => {
    jest.useRealTimers()
    queryClients.splice(0).forEach((queryClient) => queryClient.clear())
    if (originalFetch) globalThis.fetch = originalFetch
    else Reflect.deleteProperty(globalThis, 'fetch')
  })

  it.each(['zh', 'en', 'ja', 'ko'] as const)(
    'sends complete title and content sources through the strict %s contract',
    async (targetLang) => {
      mockLanguage = targetLang
      const sourceTitle =
        targetLang === 'en'
          ? `完整中文标题${'文'.repeat(420)}`
          : `Complete English title ${'x'.repeat(640)}`
      const sourceContent =
        targetLang === 'en'
          ? `完整中文正文${'内'.repeat(620)}`
          : `Complete English content ${'y'.repeat(840)}`
      postsQuery.mockResolvedValue({
        data: [rawPost({ title: sourceTitle, content: sourceContent })],
        error: null,
      })
      const requests = installPendingTranslations()

      renderWidget()

      await waitFor(() => expect(requests).toHaveLength(1))
      expect(requests[0].body).toEqual({
        targetLang,
        items: [
          {
            id: 'item-0',
            text: sourceTitle,
            contentType: 'post_title',
            contentId: 'post-1',
          },
          {
            id: 'item-1',
            text: sourceContent,
            contentType: 'post_content',
            contentId: 'post-1',
          },
        ],
      })
      expect(requests[0].options).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN_A}`,
          'x-csrf-token': 'csrf-sidebar',
        },
      })
      expect(busyRegion()).toHaveAttribute('aria-busy', 'true')

      requests[0].pending.resolve(
        response(translatedEnvelope(requests[0].body, `translated-${targetLang}`))
      )

      expect(await screen.findByText(`translated-${targetLang}-post_title`)).toBeInTheDocument()
      expect(screen.getByText(`translated-${targetLang}-post_content`)).toBeInTheDocument()
      expect(screen.getByText('TR')).toBeInTheDocument()
      expect(busyRegion()).toHaveAttribute('aria-busy', 'false')
      expect(screen.getByRole('link')).toHaveStyle({ minHeight: '44px' })
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    [
      'partial result',
      (body: TranslationBody) =>
        batchEnvelope(
          {
            [body.items[0].id]: { translatedText: 'Only title', cached: false },
          },
          body.items.length
        ),
    ],
    [
      'extra result',
      (body: TranslationBody) => ({
        ...translatedEnvelope(body, 'valid'),
        data: {
          ...translatedEnvelope(body, 'valid').data,
          results: {
            ...translatedEnvelope(body, 'valid').data.results,
            injected: { translatedText: 'Injected', cached: false },
          },
        },
      }),
    ],
    [
      'source echo',
      (body: TranslationBody) =>
        batchEnvelope(
          Object.fromEntries(
            body.items.map((item, index) => [
              item.id,
              {
                translatedText: index === 0 ? item.text : `valid-${item.id}`,
                cached: false,
              },
            ])
          )
        ),
    ],
  ] as const)('fails empty and clears loading for a %s', async (_label, payload) => {
    postsQuery.mockResolvedValue({ data: [rawPost()], error: null })
    let translationCalls = 0
    globalThis.fetch = jest.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      translationCalls += 1
      const body = translationBody(options)
      return Promise.resolve(response(payload(body)))
    }) as typeof fetch

    renderWidget()

    await waitFor(() => expect(translationCalls).toBe(1))
    await waitFor(() => expect(busyRegion()).toHaveAttribute('aria-busy', 'false'))
    expect(screen.getByText('Original English title')).toBeInTheDocument()
    expect(screen.getByText('Original English content')).toBeInTheDocument()
    expect(screen.queryByText('TR')).not.toBeInTheDocument()
  })

  it.each(['fetch', 'json'] as const)(
    'physically clears loading after a 15s %s deadline even when work ignores abort',
    async (stalledPhase) => {
      jest.useFakeTimers()
      postsQuery.mockResolvedValue({ data: [rawPost()], error: null })
      let translationSignal: AbortSignal | undefined
      let translationCalls = 0
      globalThis.fetch = jest.fn((_input: RequestInfo | URL, options?: RequestInit) => {
        translationCalls += 1
        translationSignal = options?.signal as AbortSignal
        if (stalledPhase === 'fetch') return new Promise<Response>(() => undefined)
        return Promise.resolve(response(null, () => new Promise<unknown>(() => undefined)))
      }) as typeof fetch

      renderWidget()

      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(translationCalls).toBe(1)
      expect(busyRegion()).toHaveAttribute('aria-busy', 'true')

      await act(async () => {
        await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
      })
      expect(translationSignal?.aborted).toBe(true)
      expect(busyRegion()).toHaveAttribute('aria-busy', 'false')
      expect(screen.getByText('Original English title')).toBeInTheDocument()
      expect(screen.queryByText('TR')).not.toBeInTheDocument()
    }
  )

  it('single-flights identical work and isolates every identity, language, id, and source generation', async () => {
    const initialPost = rawPost()
    postsQuery.mockResolvedValue({ data: [initialPost], error: null })
    const requests = installPendingTranslations()
    let auth = authenticatedSession()
    mockUseAuthSession.mockImplementation(() => auth)
    const view = renderWidget()

    await waitFor(() => expect(requests).toHaveLength(1))
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    expect(requests).toHaveLength(1)

    auth = authenticatedSession(accessTokenFor(USER_A, 'b'))
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0].options.signal?.aborted).toBe(true)

    auth = authenticatedSession(accessTokenFor(USER_A, 'b'), 2)
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[1].options.signal?.aborted).toBe(true)

    auth = authenticatedSession(accessTokenFor(USER_B, 'c'), 3, USER_B)
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[2].options.signal?.aborted).toBe(true)

    mockLanguage = 'ko'
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    await waitFor(() => expect(requests).toHaveLength(5))
    expect(requests[3].options.signal?.aborted).toBe(true)

    const revisedPost = rawPost({
      id: 'post-2',
      title: 'Revised English title',
      content: 'Revised English content',
    })
    act(() => {
      view.queryClient.setQueryData(['hot-discussions', 8], [revisedPost])
    })
    await waitFor(() => expect(requests).toHaveLength(6))
    expect(requests[4].options.signal?.aborted).toBe(true)

    const sameIdRevision = rawPost({
      id: 'post-2',
      title: 'Same id, newer English title',
      content: 'Same id, newer English content',
    })
    act(() => {
      view.queryClient.setQueryData(['hot-discussions', 8], [sameIdRevision])
    })
    await waitFor(() => expect(requests).toHaveLength(7))
    expect(requests[5].options.signal?.aborted).toBe(true)
    expect(requests[6].body.items.map((item) => item.text)).toEqual([
      sameIdRevision.title,
      sameIdRevision.content,
    ])

    await act(async () => {
      requests.slice(0, 6).forEach((request, index) => {
        request.pending.resolve(response(translatedEnvelope(request.body, `stale-${index}`)))
      })
      await Promise.resolve()
    })
    expect(screen.queryByText(/stale-/)).not.toBeInTheDocument()
    expect(screen.getByText('Same id, newer English title')).toBeInTheDocument()
    expect(busyRegion()).toHaveAttribute('aria-busy', 'true')

    requests[6].pending.resolve(response(translatedEnvelope(requests[6].body, 'fresh')))
    expect(await screen.findByText('fresh-post_title')).toBeInTheDocument()
    expect(screen.getByText('fresh-post_content')).toBeInTheDocument()
    expect(busyRegion()).toHaveAttribute('aria-busy', 'false')
  })

  it('restores last-good only for the exact same scope after cancellation', async () => {
    postsQuery.mockResolvedValue({ data: [rawPost()], error: null })
    const requests = installPendingTranslations()
    const view = renderWidget()

    await waitFor(() => expect(requests).toHaveLength(1))
    requests[0].pending.resolve(response(translatedEnvelope(requests[0].body, 'japanese')))
    expect(await screen.findByText('japanese-post_title')).toBeInTheDocument()

    mockLanguage = 'ko'
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(screen.queryByText('japanese-post_title')).not.toBeInTheDocument()
    expect(screen.getByText('Original English title')).toBeInTheDocument()

    mockLanguage = 'ja'
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    expect(requests[1].options.signal?.aborted).toBe(true)
    await waitFor(() => expect(screen.getByText('japanese-post_title')).toBeInTheDocument())
    expect(requests).toHaveLength(2)
    expect(busyRegion()).toHaveAttribute('aria-busy', 'false')

    requests[1].pending.resolve(response(translatedEnvelope(requests[1].body, 'late-korean')))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('late-korean-post_title')).not.toBeInTheDocument()
    expect(screen.getByText('japanese-post_title')).toBeInTheDocument()
  })

  it('reuses the exact owner cache after a same-user token refresh', async () => {
    postsQuery.mockResolvedValue({ data: [rawPost()], error: null })
    const requests = installPendingTranslations()
    let auth = authenticatedSession()
    mockUseAuthSession.mockImplementation(() => auth)
    const view = renderWidget()

    await waitFor(() => expect(requests).toHaveLength(1))
    requests[0].pending.resolve(response(translatedEnvelope(requests[0].body, 'cached')))
    expect(await screen.findByText('cached-post_title')).toBeInTheDocument()

    auth = authenticatedSession(accessTokenFor(USER_A, 'refreshed'))
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )

    await waitFor(() => expect(busyRegion()).toHaveAttribute('aria-busy', 'false'))
    expect(requests).toHaveLength(1)
    expect(screen.getByText('cached-post_title')).toBeInTheDocument()
  })

  it('fails closed when the bearer subject does not match the rendered viewer', async () => {
    postsQuery.mockResolvedValue({ data: [rawPost()], error: null })
    mockUseAuthSession.mockReturnValue(
      authenticatedSession(accessTokenFor(USER_B, 'mismatch'), 1, USER_A)
    )
    const requests = installPendingTranslations()

    renderWidget()

    expect(await screen.findByText('Original English title')).toBeInTheDocument()
    expect(requests).toHaveLength(0)
    expect(busyRegion()).toHaveAttribute('aria-busy', 'false')
  })

  it('aborts translation on unmount and cannot publish late work', async () => {
    postsQuery.mockResolvedValue({ data: [rawPost()], error: null })
    const requests = installPendingTranslations()
    const view = renderWidget()

    await waitFor(() => expect(requests).toHaveLength(1))
    view.unmount()
    expect(requests[0].options.signal?.aborted).toBe(true)

    requests[0].pending.resolve(response(translatedEnvelope(requests[0].body, 'late')))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('late-post_title')).not.toBeInTheDocument()
  })

  it('keeps deferred loading truthful instead of flashing a successful empty state', async () => {
    mockDeferredReady = false
    postsQuery.mockResolvedValue({ data: [], error: null })
    const view = renderWidget()

    expect(postsQuery).not.toHaveBeenCalled()
    expect(busyRegion()).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('No discussions')).not.toBeInTheDocument()
    expect(view.container.querySelectorAll('.skeleton')).toHaveLength(5)

    mockDeferredReady = true
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <HotDiscussions />
      </QueryClientProvider>
    )
    await waitFor(() => expect(postsQuery).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('No discussions')).toBeInTheDocument()
    expect(busyRegion()).toHaveAttribute('aria-busy', 'false')
  })

  it('distinguishes a query failure from empty data and provides a 44px retry', async () => {
    postsQuery
      .mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } })
      .mockResolvedValueOnce({ data: [], error: null })
    globalThis.fetch = jest.fn(() => {
      throw new Error('Translation should not run without posts')
    }) as typeof fetch

    renderWidget()

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load')
    expect(screen.queryByText('No discussions')).not.toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).toHaveStyle({ minWidth: '44px', minHeight: '44px' })

    fireEvent.click(retry)
    await waitFor(() => expect(postsQuery).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No discussions')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
