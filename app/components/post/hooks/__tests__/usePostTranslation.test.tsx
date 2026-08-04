import { act, renderHook, waitFor } from '@testing-library/react'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import type { Comment } from '../usePostComments'
import { usePostTranslation } from '../usePostTranslation'

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-test' }),
}))

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response
}

function singleEnvelope(
  originalText: string,
  targetLang: 'zh' | 'en',
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
  overrides: Record<string, unknown> = {}
) {
  const total = Object.keys(results).length
  return {
    success: true,
    data: {
      results,
      total,
      cached: 0,
      translated: total,
      ...overrides,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderTranslationHook(initialToken = 'token-a', initialLanguage = 'en') {
  const showToast = jest.fn()
  const hook = renderHook(
    ({ accessToken, language }: { accessToken: string | null; language?: string }) =>
      usePostTranslation({
        accessToken,
        language,
        showToast,
        t: (key) => key,
      }),
    { initialProps: { accessToken: initialToken as string | null, language: initialLanguage } }
  )
  return { ...hook, showToast }
}

function makeComment(id: string, content: string, replies?: Comment[]): Comment {
  return { id, content, created_at: '2026-08-03T00:00:00.000Z', replies }
}

describe('usePostTranslation truth boundaries', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: jest.fn(),
      writable: true,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    if (originalFetch) {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
        writable: true,
      })
    } else {
      Reflect.deleteProperty(globalThis, 'fetch')
    }
  })

  it('publishes only the exact single receipt and preserves source images', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(jsonResponse(singleEnvelope('交易策略', 'en', 'Trading strategy')))
    const { result, showToast } = renderTranslationHook()

    await act(async () => {
      await result.current.translateContent(
        'post-1',
        '交易策略\n\n![chart](https://example.com/chart.png)',
        'en'
      )
    })

    expect(result.current.translatedContent).toBe(
      'Trading strategy\n\n![chart](https://example.com/chart.png)'
    )
    expect(result.current.showingOriginal).toBe(false)
    expect(result.current.translating).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('rejects a mismatched source receipt instead of treating it as a translation', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(
      jsonResponse(singleEnvelope('别人的原文', 'en', 'Someone else text'))
    )
    const { result, showToast } = renderTranslationHook()

    await act(async () => {
      await result.current.translateContent('post-1', '交易策略', 'en')
    })

    expect(result.current.translatedContent).toBeNull()
    expect(result.current.showingOriginal).toBe(true)
    expect(result.current.translating).toBe(false)
    expect(showToast).toHaveBeenCalledWith('translationServiceError', 'error')
  })

  it('coalesces identical content requests into one physical request', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const { result } = renderTranslationHook()

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.translateContent('post-1', '交易策略', 'en')
      second = result.current.translateContent('post-1', '交易策略', 'en')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    body.resolve(singleEnvelope('交易策略', 'en', 'Trading strategy'))
    await act(async () => {
      await Promise.all([first, second])
    })
    expect(result.current.translatedContent).toBe('Trading strategy')
  })

  it('releases the single-item loading state at the hard deadline', async () => {
    jest.useFakeTimers()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockReturnValue(new Promise(() => undefined))
    const { result, showToast } = renderTranslationHook()

    let request!: Promise<void>
    act(() => {
      request = result.current.translateContent('post-1', '交易策略', 'en')
    })
    expect(result.current.translating).toBe(true)

    await act(async () => {
      await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
      await request
    })
    expect(result.current.translating).toBe(false)
    expect(result.current.translatedContent).toBeNull()
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('drops a late single response after the authenticated viewer changes', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const { result, rerender, showToast } = renderTranslationHook()

    let request!: Promise<void>
    act(() => {
      request = result.current.translateContent('post-1', '交易策略', 'en')
    })
    rerender({ accessToken: 'token-b', language: 'en' })
    body.resolve(singleEnvelope('交易策略', 'en', 'Stale translation'))
    await act(async () => {
      await request
    })

    expect(result.current.translatedContent).toBeNull()
    expect(result.current.translating).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('never reuses a completed translation across UI language scopes', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleEnvelope('交易策略', 'en', 'Trading strategy')))
      .mockResolvedValueOnce(jsonResponse(singleEnvelope('Trading strategy', 'zh', '交易策略')))
    const { result, rerender } = renderTranslationHook('token-a', 'en')

    await act(async () => {
      await result.current.translateContent('post-1', '交易策略', 'en')
    })
    expect(result.current.translatedContent).toBe('Trading strategy')

    rerender({ accessToken: 'token-a', language: 'zh' })
    expect(result.current.translatedContent).toBeNull()
    await act(async () => {
      await result.current.translateContent('post-1', 'Trading strategy', 'zh')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.translatedContent).toBe('交易策略')
  })

  it('maps a complete post batch by opaque item IDs even when post IDs contain underscores', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(
      jsonResponse(
        batchEnvelope({
          'item-0': { translatedText: 'Translated title', cached: false },
          'item-1': { translatedText: 'Translated body', cached: false },
        })
      )
    )
    const { result } = renderTranslationHook()

    await act(async () => {
      await result.current.translateListPosts(
        [{ id: 'post_with_underscore', title: '交易标题', content: '交易正文' }],
        'en'
      )
    })

    expect(result.current.translatedListPosts).toEqual({
      post_with_underscore: { title: 'Translated title', body: 'Translated body' },
    })
    expect(result.current.translatingList).toBe(false)
    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
    expect(requestBody.items.map((item: { id: string }) => item.id)).toEqual(['item-0', 'item-1'])
  })

  it('publishes none of a batch when the API silently omits one requested item', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(
      jsonResponse(
        batchEnvelope(
          { 'item-0': { translatedText: 'Only title', cached: false } },
          { total: 2, translated: 2 }
        )
      )
    )
    const { result } = renderTranslationHook()

    await act(async () => {
      await result.current.translateListPosts(
        [{ id: 'post-1', title: '交易标题', content: '交易正文' }],
        'en'
      )
    })

    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatingList).toBe(false)
  })

  it('coalesces identical list batches into one physical request', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const { result } = renderTranslationHook()
    const posts = [{ id: 'post-1', title: '交易标题' }]

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.translateListPosts(posts, 'en')
      second = result.current.translateListPosts(posts, 'en')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    body.resolve(batchEnvelope({ 'item-0': { translatedText: 'Trading title', cached: false } }))
    await act(async () => {
      await Promise.all([first, second])
    })
    expect(result.current.translatedListPosts['post-1']?.title).toBe('Trading title')
  })

  it('does not publish identity echoes as list or comment translations', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(batchEnvelope({ 'item-0': { translatedText: '交易标题', cached: true } }))
      )
      .mockResolvedValueOnce(
        jsonResponse(batchEnvelope({ 'item-0': { translatedText: '交易评论', cached: true } }))
      )
    const { result } = renderTranslationHook()

    await act(async () => {
      await result.current.translateListPosts([{ id: 'post-1', title: '交易标题' }], 'en')
      await result.current.translateComments([makeComment('comment-1', '交易评论')], 'en')
    })

    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatedComments).toEqual({})
    expect(result.current.translatingComments).toBe(false)
  })

  it('clears language caches and ignores a late comment response from the old language', async () => {
    const oldBody = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => oldBody.promise,
    } as Response)
    const { result, rerender } = renderTranslationHook('token-a', 'en')

    let request!: Promise<void>
    act(() => {
      request = result.current.translateComments([makeComment('comment-1', '交易评论')], 'en')
    })
    rerender({ accessToken: 'token-a', language: 'zh' })
    oldBody.resolve(
      batchEnvelope({ 'item-0': { translatedText: 'Stale English comment', cached: false } })
    )
    await act(async () => {
      await request
    })

    await waitFor(() => expect(result.current.translatingComments).toBe(false))
    expect(result.current.translatedComments).toEqual({})
  })
})
