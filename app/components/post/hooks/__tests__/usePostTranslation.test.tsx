import { act, renderHook, waitFor } from '@testing-library/react'
import { TRANSLATION_REQUEST_TIMEOUT_MS } from '@/lib/translations/translation-client-contract'
import type { Comment } from '../usePostComments'
import {
  resetPostTranslationCoordinatorForTests,
  usePostTranslation,
  type TranslatablePost,
} from '../usePostTranslation'

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-test' }),
}))

type HookProps = Parameters<typeof usePostTranslation>[0]

function jwtFor(subject: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: subject })}.signature`
}

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

function makeComment(id: string, content: string, replies?: Comment[]): Comment {
  return { id, content, created_at: '2026-08-03T00:00:00.000Z', replies }
}

function renderTranslationHook(overrides: Partial<HookProps> = {}) {
  const showToast = jest.fn()
  let currentProps: HookProps = {
    accessToken: jwtFor('user-a'),
    authChecked: true,
    isLoggedIn: true,
    userId: 'user-a',
    viewerKey: 'user:user-a',
    sessionGeneration: 1,
    language: 'en',
    activePost: { id: 'post-1', content: '交易策略' },
    listPosts: [],
    comments: [],
    showToast,
    t: (key) => key,
    ...overrides,
  }
  const hook = renderHook((props: HookProps) => usePostTranslation(props), {
    initialProps: currentProps,
  })
  const rerenderWith = (next: Partial<HookProps>) => {
    currentProps = { ...currentProps, ...next }
    hook.rerender(currentProps)
  }
  return { ...hook, rerenderWith, showToast }
}

describe('usePostTranslation truth boundaries', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetPostTranslationCoordinatorForTests()
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: jest.fn(),
      writable: true,
    })
  })

  afterEach(() => {
    resetPostTranslationCoordinatorForTests()
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

  it('sends the complete content, publishes the exact receipt, and preserves source images', async () => {
    const content = `${'交易策略。'.repeat(80)}\n\n![chart](https://example.com/chart.png)`
    const source = '交易策略。'.repeat(80)
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(jsonResponse(singleEnvelope(source, 'en', 'Full translation')))
    const { result } = renderTranslationHook({
      activePost: { id: 'post-1', content },
    })

    await act(async () => {
      await result.current.translateContent('post-1', content, 'en')
    })

    const requestBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
    expect(requestBody.text).toBe(source)
    expect(requestBody.text.length).toBeGreaterThan(200)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${jwtFor('user-a')}` })
    )
    expect(result.current.translatedContent).toBe(
      'Full translation\n\n![chart](https://example.com/chart.png)'
    )
    expect(result.current.showingOriginal).toBe(false)
    expect(result.current.translating).toBe(false)
  })

  it('requires checked logged-in owner identity and a matching JWT subject', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    const invalidScopes: Partial<HookProps>[] = [
      { authChecked: false },
      { isLoggedIn: false },
      { viewerKey: 'user:user-b' },
      { accessToken: jwtFor('user-b') },
      { accessToken: 'opaque-token' },
      { userId: null },
    ]

    for (const invalid of invalidScopes) {
      const { result, unmount } = renderTranslationHook(invalid)
      await act(async () => {
        await result.current.translateContent('post-1', '交易策略', 'en')
      })
      unmount()
    }

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never shares pending work or cached text across viewer epochs', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(jsonResponse(singleEnvelope('交易策略', 'en', 'Trading strategy')))
    const viewerA = renderTranslationHook()
    const viewerB = renderTranslationHook({
      accessToken: jwtFor('user-b'),
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })

    await act(async () => {
      await Promise.all([
        viewerA.result.current.translateContent('post-1', '交易策略', 'en'),
        viewerB.result.current.translateContent('post-1', '交易策略', 'en'),
      ])
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      fetchMock.mock.calls.map((call) => (call[1]?.headers as Record<string, string>).Authorization)
    ).toEqual([`Bearer ${jwtFor('user-a')}`, `Bearer ${jwtFor('user-b')}`])
    viewerA.unmount()
    viewerB.unmount()
  })

  it('matches the conservative server detector for pure, mixed, and ambiguous sources', () => {
    const { result } = renderTranslationHook()

    // Han-only text is shared by Chinese and Japanese, so the provider must
    // decide instead of the client inventing a same-language result.
    expect(result.current.needsTranslation('这是中文内容', 'zh')).toBe(true)
    expect(result.current.needsTranslation('Trading strategy', 'en')).toBe(false)
    expect(result.current.needsTranslation('取引の戦略', 'ja')).toBe(false)
    expect(result.current.needsTranslation('거래 전략', 'ko')).toBe(false)
    expect(result.current.needsTranslation('仮想通貨市場', 'zh')).toBe(true)
    expect(result.current.needsTranslation('交易策略', 'zh')).toBe(true)
    expect(result.current.needsTranslation('AI交易', 'en')).toBe(true)
    expect(result.current.needsTranslation('Trading markets rallied 거래', 'en')).toBe(true)
    expect(result.current.needsTranslation('Trading 거래 전략', 'ko')).toBe(true)
    expect(result.current.needsTranslation('Trading の戦略', 'ja')).toBe(true)
    expect(result.current.needsTranslation('交易 AI', 'en')).toBe(true)
    expect(result.current.needsTranslation('123 !!!', 'en')).toBe(true)
  })

  it('uses Japanese and Korean as real targets instead of falling back to English', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleEnvelope('Trading strategy', 'ja', '取引戦略')))
      .mockResolvedValueOnce(jsonResponse(singleEnvelope('Trading strategy', 'ko', '거래 전략')))
    const { result, rerenderWith } = renderTranslationHook({
      language: 'ja',
      activePost: { id: 'post-1', content: 'Trading strategy' },
    })

    await act(async () => {
      await result.current.translateContent('post-1', 'Trading strategy', 'ja')
    })
    expect(result.current.translatedContent).toBe('取引戦略')

    rerenderWith({ language: 'ko' })
    await act(async () => {
      await result.current.translateContent('post-1', 'Trading strategy', 'ko')
    })
    expect(result.current.translatedContent).toBe('거래 전략')
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(call[1]?.body as string).targetLang)
    ).toEqual(['ja', 'ko'])
  })

  it('resolves provider same-language title and content lanes without inventing text', async () => {
    const title = '行情'
    const content = '市场行情'
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(singleEnvelope(title, 'zh', title, { sameLanguage: true, cached: true }))
      )
      .mockResolvedValueOnce(
        jsonResponse(singleEnvelope(content, 'zh', content, { sameLanguage: true, cached: true }))
      )
    const { result } = renderTranslationHook({
      language: 'zh',
      activePost: { id: 'post-1', title, content },
    })

    await act(async () => {
      await result.current.translateTitle('post-1', title, 'zh')
      await result.current.translateContent('post-1', content, 'zh')
    })

    expect(result.current.translatedTitle).toBeNull()
    expect(result.current.titleTranslationResolved).toBe(true)
    expect(result.current.translatedContent).toBeNull()
    expect(result.current.contentTranslationResolved).toBe(true)
    expect(result.current.translatingTitle).toBe(false)
    expect(result.current.translating).toBe(false)
  })

  it('automatically presents a translated title beside provider-confirmed source content', async () => {
    const title = 'English market title'
    const content = '市场行情'
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleEnvelope(title, 'zh', '中文市场标题')))
      .mockResolvedValueOnce(
        jsonResponse(singleEnvelope(content, 'zh', content, { sameLanguage: true, cached: true }))
      )
    const { result } = renderTranslationHook({
      language: 'zh',
      activePost: { id: 'post-1', title, content },
    })

    await act(async () => {
      await result.current.translateTitle('post-1', title, 'zh')
      await result.current.translateContent('post-1', content, 'zh')
    })

    expect(result.current.translatedTitle).toBe('中文市场标题')
    expect(result.current.titleTranslationResolved).toBe(true)
    expect(result.current.contentTranslationResolved).toBe(true)
    expect(result.current.showingOriginal).toBe(false)
  })

  it('preserves an explicit original choice across comment rerenders and cache replay', async () => {
    const title = '交易标题'
    const content = '交易正文'
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleEnvelope(title, 'en', 'Trading title')))
      .mockResolvedValueOnce(jsonResponse(singleEnvelope(content, 'en', 'Trading body')))
    const { result, rerenderWith } = renderTranslationHook({
      activePost: { id: 'post-1', title, content },
    })

    await act(async () => {
      await result.current.translateTitle('post-1', title, 'en')
      await result.current.translateContent('post-1', content, 'en')
    })
    expect(result.current.showingOriginal).toBe(false)

    act(() => result.current.setShowingOriginal(true))
    rerenderWith({ comments: [makeComment('comment-1', '新评论')] })
    await act(async () => {
      await result.current.translateTitle('post-1', title, 'en')
      await result.current.translateContent('post-1', content, 'en')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.translatedTitle).toBe('Trading title')
    expect(result.current.translatedContent).toBe('Trading body')
    expect(result.current.showingOriginal).toBe(true)
  })

  it('isolates the active title from an already-pending all-or-nothing feed batch', async () => {
    const title = '交易标题'
    const posts = [
      { id: 'post-1', title, content: '交易正文' },
      { id: 'post-2', title: '另一个标题', content: '另一个正文' },
    ]
    const bulkBody = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockImplementation((_input, options) => {
      const request = JSON.parse(options?.body as string) as { items?: unknown[]; text?: string }
      if (request.items) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => bulkBody.promise,
        } as Response)
      }
      return Promise.resolve(jsonResponse(singleEnvelope(title, 'en', 'Trading title')))
    })
    const { result } = renderTranslationHook({
      activePost: posts[0],
      listPosts: posts,
    })

    let bulkRequest!: Promise<void>
    let titleRequest!: Promise<void>
    act(() => {
      bulkRequest = result.current.translateListPosts(posts, 'en')
      titleRequest = result.current.translateTitle('post-1', title, 'en')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toHaveProperty('items')
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      text: title,
      contentType: 'post_title',
      contentId: 'post-1',
    })

    await act(async () => {
      await titleRequest
    })
    expect(result.current.translatedTitle).toBe('Trading title')
    expect(result.current.titleTranslationResolved).toBe(true)

    bulkBody.resolve(batchEnvelope({}))
    await act(async () => {
      await bulkRequest
    })
    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatedTitle).toBe('Trading title')
  })

  it('keeps a failed active title unresolved', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockRejectedValue(new Error('title provider unavailable'))
    const { result, showToast } = renderTranslationHook({
      activePost: { id: 'post-1', title: '交易标题', content: '交易正文' },
    })

    await act(async () => {
      await result.current.translateTitle('post-1', '交易标题', 'en')
    })

    expect(result.current.translatedTitle).toBeNull()
    expect(result.current.titleTranslationResolved).toBe(false)
    expect(result.current.translatingTitle).toBe(false)
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

  it('shares a pending feed body with detail without letting one subscriber abort the other', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const posts = [{ id: 'post-1', content: '交易策略' }]
    const feed = renderTranslationHook({ activePost: null, listPosts: posts })
    const detail = renderTranslationHook({ activePost: posts[0], listPosts: [] })

    let feedRequest!: Promise<void>
    let detailRequest!: Promise<void>
    act(() => {
      feedRequest = feed.result.current.translateListPosts(posts, 'en')
      detailRequest = detail.result.current.translateContent('post-1', '交易策略', 'en')
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      items: [
        {
          id: 'item-0',
          text: '交易策略',
          contentType: 'post_content',
          contentId: 'post-1',
        },
      ],
      targetLang: 'en',
    })

    const physicalSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    act(() => feed.unmount())
    expect(physicalSignal.aborted).toBe(false)

    body.resolve(batchEnvelope({ 'item-0': { translatedText: 'Trading strategy', cached: false } }))
    await act(async () => {
      await Promise.all([feedRequest, detailRequest])
    })

    expect(detail.result.current.translatedContent).toBe('Trading strategy')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    detail.unmount()
  })

  it('releases the single-item busy lane at the hard deadline', async () => {
    jest.useFakeTimers()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockReturnValue(new Promise(() => undefined))
    const { result, showToast } = renderTranslationHook()

    let request!: Promise<void>
    act(() => {
      request = result.current.translateContent('post-1', '交易策略', 'en')
    })
    expect(result.current.translating).toBe(true)
    expect(result.current.translatingContentPostId).toBe('post-1')

    await act(async () => {
      await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
      await request
    })
    expect(result.current.translating).toBe(false)
    expect(result.current.translatingContentPostId).toBeNull()
    expect(showToast).toHaveBeenCalledWith('translationServiceError', 'error')
  })

  it('shares an image-only source revision without ever appending stale media', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const oldContent = '交易策略\n\n![old](https://example.com/old.png)'
    const newContent = '交易策略\n\n![new](https://example.com/new.png)'
    const { result, rerenderWith } = renderTranslationHook({
      activePost: { id: 'post-1', content: oldContent },
    })

    let oldRequest!: Promise<void>
    act(() => {
      oldRequest = result.current.translateContent('post-1', oldContent, 'en')
    })
    rerenderWith({ activePost: { id: 'post-1', content: newContent } })
    expect(result.current.translatedContent).toBeNull()

    let newRequest!: Promise<void>
    act(() => {
      newRequest = result.current.translateContent('post-1', newContent, 'en')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    body.resolve(singleEnvelope('交易策略', 'en', 'Shared translation'))
    await act(async () => {
      await Promise.all([oldRequest, newRequest])
    })
    expect(result.current.translatedContent).toBe(
      'Shared translation\n\n![new](https://example.com/new.png)'
    )
  })

  it('cancels and fails empty immediately when the post closes or becomes same-language', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const { result, rerenderWith } = renderTranslationHook()

    let request!: Promise<void>
    act(() => {
      request = result.current.translateContent('post-1', '交易策略', 'en')
    })
    rerenderWith({ activePost: null })
    expect(result.current.translatedContent).toBeNull()
    expect(result.current.translating).toBe(false)

    body.resolve(singleEnvelope('交易策略', 'en', 'Late translation'))
    await act(async () => {
      await request
    })
    expect(result.current.translatedContent).toBeNull()

    rerenderWith({ activePost: { id: 'post-2', content: 'Already English' } })
    await act(async () => {
      await result.current.translateContent('post-2', 'Already English', 'en')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current.showingOriginal).toBe(true)
  })

  it('drops a late response on viewer, generation, token, or language scope changes', async () => {
    const body = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const { result, rerenderWith, showToast } = renderTranslationHook()

    let request!: Promise<void>
    act(() => {
      request = result.current.translateContent('post-1', '交易策略', 'en')
    })
    rerenderWith({
      accessToken: jwtFor('user-b'),
      userId: 'user-b',
      viewerKey: 'user:user-b',
      sessionGeneration: 2,
    })
    body.resolve(singleEnvelope('交易策略', 'en', 'Stale translation'))
    await act(async () => {
      await request
    })

    expect(result.current.translatedContent).toBeNull()
    expect(result.current.translating).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('isolates late responses after an exact post switch and a language switch', async () => {
    const switchedPostBody = deferred<unknown>()
    const switchedLanguageBody = deferred<unknown>()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => switchedPostBody.promise,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => switchedLanguageBody.promise,
      } as Response)
    const { result, rerenderWith } = renderTranslationHook()

    let oldPostRequest!: Promise<void>
    act(() => {
      oldPostRequest = result.current.translateContent('post-1', '交易策略', 'en')
    })
    rerenderWith({ activePost: { id: 'post-2', content: '交易策略' } })
    switchedPostBody.resolve(singleEnvelope('交易策略', 'en', 'Wrong post'))
    await act(async () => {
      await oldPostRequest
    })
    expect(result.current.translatedContent).toBeNull()

    let oldLanguageRequest!: Promise<void>
    act(() => {
      oldLanguageRequest = result.current.translateContent('post-2', '交易策略', 'en')
    })
    rerenderWith({ language: 'ja' })
    switchedLanguageBody.resolve(singleEnvelope('交易策略', 'en', 'Wrong language'))
    await act(async () => {
      await oldLanguageRequest
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.translatedContent).toBeNull()
    expect(result.current.translating).toBe(false)
  })

  it('cancels pending list and comment batches when their resources become empty', async () => {
    const listBody = deferred<unknown>()
    const commentBody = deferred<unknown>()
    const posts = [{ id: 'post-1', title: '交易标题' }]
    const comments = [makeComment('comment-1', '交易评论')]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => listBody.promise,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => commentBody.promise,
      } as Response)
    const { result, rerenderWith } = renderTranslationHook({ listPosts: posts, comments })

    let listRequest!: Promise<void>
    let commentRequest!: Promise<void>
    act(() => {
      listRequest = result.current.translateListPosts(posts, 'en')
      commentRequest = result.current.translateComments(comments, 'en')
    })
    rerenderWith({ listPosts: [], comments: [] })
    expect(result.current.translatingList).toBe(false)
    expect(result.current.translatingComments).toBe(false)
    await act(async () => Promise.resolve())
    expect(fetchMock.mock.calls.every((call) => (call[1]?.signal as AbortSignal).aborted)).toBe(
      true
    )

    listBody.resolve(batchEnvelope({ 'item-0': { translatedText: 'Stale title', cached: false } }))
    commentBody.resolve(
      batchEnvelope({ 'item-0': { translatedText: 'Stale comment', cached: false } })
    )
    await act(async () => {
      await Promise.all([listRequest, commentRequest])
    })

    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatedComments).toEqual({})
  })

  it('translates every post and full body in chunks of at most twenty', async () => {
    const longBody = '完整正文。'.repeat(80)
    const posts: TranslatablePost[] = Array.from({ length: 12 }, (_, index) => ({
      id: `post-${index}`,
      title: `交易标题${index}`,
      content: longBody,
    }))
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init?.body as string) as {
        items: Array<{ id: string; text: string }>
      }
      return jsonResponse(
        batchEnvelope(
          Object.fromEntries(
            request.items.map((item) => [
              item.id,
              { translatedText: `translated:${item.id}`, cached: false },
            ])
          )
        )
      )
    })
    const { result } = renderTranslationHook({ listPosts: posts })

    let request!: Promise<void>
    act(() => {
      request = result.current.translateListPosts(posts, 'en')
    })
    expect(Object.keys(result.current.translatingListLanes)).toHaveLength(12)
    await act(async () => {
      await request
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const requestBodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1]?.body as string))
    expect(requestBodies.map((body) => body.items.length)).toEqual([20, 4])
    const bodyItems = requestBodies
      .flatMap((body) => body.items)
      .filter((item) => item.contentType === 'post_content')
    expect(bodyItems).toHaveLength(12)
    expect(bodyItems.every((item) => item.text.length > 200)).toBe(true)
    expect(Object.keys(result.current.translatedListPosts)).toHaveLength(12)
    expect(result.current.translatingList).toBe(false)
  })

  it('keeps four maximum-length bodies in the API aggregate character budget', async () => {
    const posts: TranslatablePost[] = Array.from({ length: 4 }, (_, index) => ({
      id: `post-${index}`,
      content: '交'.repeat(50_000),
    }))
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init?.body as string) as {
        items: Array<{ id: string; text: string }>
      }
      return jsonResponse(
        batchEnvelope(
          Object.fromEntries(
            request.items.map((item) => [
              item.id,
              { translatedText: `translated:${item.id}`, cached: false },
            ])
          )
        )
      )
    })
    const { result } = renderTranslationHook({ listPosts: posts })

    await act(async () => {
      await result.current.translateListPosts(posts, 'en')
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)
    expect(request.items).toHaveLength(4)
    expect(
      request.items.reduce((total: number, item: { text: string }) => total + item.text.length, 0)
    ).toBe(200_000)
    expect(Object.keys(result.current.translatedListPosts)).toHaveLength(4)
  })

  it('splits five maximum-length bodies and publishes only after every physical group succeeds', async () => {
    const finalBody = deferred<unknown>()
    const posts: TranslatablePost[] = Array.from({ length: 5 }, (_, index) => ({
      id: `post-${index}`,
      content: '交'.repeat(50_000),
    }))
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init?.body as string) as {
        items: Array<{ id: string; text: string }>
      }
      const envelope = batchEnvelope(
        Object.fromEntries(
          request.items.map((item) => [
            item.id,
            { translatedText: `translated:${item.id}`, cached: false },
          ])
        )
      )
      return request.items[0]?.id === 'item-4'
        ? ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: () => finalBody.promise,
          } as Response)
        : jsonResponse(envelope)
    })
    const { result } = renderTranslationHook({ listPosts: posts })

    let request!: Promise<void>
    act(() => {
      request = result.current.translateListPosts(posts, 'en')
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(call[1]?.body as string).items.length)
    ).toEqual([4, 1])
    expect(
      fetchMock.mock.calls.map((call) =>
        JSON.parse(call[1]?.body as string).items.reduce(
          (total: number, item: { text: string }) => total + item.text.length,
          0
        )
      )
    ).toEqual([200_000, 50_000])
    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatingList).toBe(true)

    finalBody.resolve(
      batchEnvelope({ 'item-4': { translatedText: 'translated:item-4', cached: false } })
    )
    await act(async () => {
      await request
    })

    expect(Object.keys(result.current.translatedListPosts)).toHaveLength(5)
    expect(result.current.translatingList).toBe(false)
  })

  it('publishes no new post result and aborts sibling work when any chunk is invalid', async () => {
    const posts: TranslatablePost[] = Array.from({ length: 21 }, (_, index) => ({
      id: `post-${index}`,
      title: `交易标题${index}`,
    }))
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    let siblingSignal: AbortSignal | undefined
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init?.body as string) as { items: Array<{ id: string }> }
      if (request.items[0]?.id === 'item-0') {
        return jsonResponse(batchEnvelope({}))
      }
      siblingSignal = init?.signal as AbortSignal
      return new Promise<Response>(() => undefined)
    })
    const { result } = renderTranslationHook({ listPosts: posts })

    await act(async () => {
      await result.current.translateListPosts(posts, 'en')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatingListLanes).toEqual({})
    await act(async () => Promise.resolve())
    expect(siblingSignal?.aborted).toBe(true)
  })

  it('recursively translates every comment and keeps multi-chunk publication atomic', async () => {
    const replies = Array.from({ length: 21 }, (_, index) =>
      makeComment(`reply-${index}`, `交易回复${index}`)
    )
    const comments = [makeComment('root', '交易根评论', replies)]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init?.body as string) as { items: Array<{ id: string }> }
      return jsonResponse(
        batchEnvelope(
          Object.fromEntries(
            request.items.map((item) => [
              item.id,
              { translatedText: `translated:${item.id}`, cached: false },
            ])
          )
        )
      )
    })
    const { result } = renderTranslationHook({ comments })

    await act(async () => {
      await result.current.translateComments(comments, 'en')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Object.keys(result.current.translatedComments)).toHaveLength(22)
    expect(result.current.translatingCommentLanes).toEqual({})
  })

  it('clears list and comment truth for empty or same-language resources', async () => {
    const posts = [{ id: 'post-1', title: '交易标题' }]
    const comments = [makeComment('comment-1', '交易评论')]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          batchEnvelope({ 'item-0': { translatedText: 'Trading title', cached: false } })
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          batchEnvelope({ 'item-0': { translatedText: 'Trading comment', cached: false } })
        )
      )
    const { result, rerenderWith } = renderTranslationHook({ listPosts: posts, comments })

    await act(async () => {
      await result.current.translateListPosts(posts, 'en')
      await result.current.translateComments(comments, 'en')
    })
    expect(result.current.translatedListPosts['post-1']?.title).toBe('Trading title')
    expect(result.current.translatedComments['comment-1']).toBe('Trading comment')

    rerenderWith({
      listPosts: [{ id: 'post-1', title: 'Already English' }],
      comments: [],
    })
    await act(async () => {
      await result.current.translateListPosts([{ id: 'post-1', title: 'Already English' }], 'en')
      await result.current.translateComments([], 'en')
    })

    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatedComments).toEqual({})
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects incomplete single and batch receipts without publishing them', async () => {
    const posts = [{ id: 'post-1', title: '交易标题', content: '交易正文' }]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(jsonResponse(singleEnvelope('别人的原文', 'en', 'Wrong')))
      .mockResolvedValueOnce(
        jsonResponse(
          batchEnvelope(
            { 'item-0': { translatedText: 'Only title', cached: false } },
            { total: 2, translated: 2 }
          )
        )
      )
    const { result, showToast } = renderTranslationHook({
      activePost: { id: 'post-1', title: '交易标题', content: '交易正文' },
      listPosts: posts,
    })

    await act(async () => {
      await result.current.translateContent('post-1', '交易正文', 'en')
      await result.current.translateListPosts(posts, 'en')
    })

    expect(result.current.translatedContent).toBeNull()
    expect(result.current.translatedListPosts).toEqual({})
    expect(showToast).toHaveBeenCalledWith('translationServiceError', 'error')
  })

  it('does not publish identity echoes as list or comment translations', async () => {
    const posts = [{ id: 'post-1', title: '交易标题' }]
    const comments = [makeComment('comment-1', '交易评论')]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(batchEnvelope({ 'item-0': { translatedText: '交易标题', cached: true } }))
      )
      .mockResolvedValueOnce(
        jsonResponse(batchEnvelope({ 'item-0': { translatedText: '交易评论', cached: true } }))
      )
    const { result } = renderTranslationHook({ listPosts: posts, comments })

    await act(async () => {
      await result.current.translateListPosts(posts, 'en')
      await result.current.translateComments(comments, 'en')
    })

    expect(result.current.translatedListPosts).toEqual({})
    expect(result.current.translatedComments).toEqual({})
  })

  it('coalesces identical multi-item sources into one physical batch set', async () => {
    const body = deferred<unknown>()
    const posts = [{ id: 'post-1', title: '交易标题' }]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => body.promise,
    } as Response)
    const { result } = renderTranslationHook({ listPosts: posts })

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

  it('fails closed for duplicate recursive comment IDs', async () => {
    const duplicate = makeComment('same-id', '交易回复')
    const comments = [makeComment('same-id', '交易评论', [duplicate])]
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    const { result } = renderTranslationHook({ comments })

    await act(async () => {
      await result.current.translateComments(comments, 'en')
    })

    await waitFor(() => expect(result.current.translatingComments).toBe(false))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.translatedComments).toEqual({})
  })
})
