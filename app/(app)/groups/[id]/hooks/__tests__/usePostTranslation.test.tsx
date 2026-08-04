import { act, renderHook, waitFor } from '@testing-library/react'
import type { BatchTranslationItem } from '@/lib/translations/translation-client-contract'
import { usePostTranslation } from '../usePostTranslation'
import type { Post } from '../useGroupPosts'

const mockRequestBatchTranslation = jest.fn()
const mockLoggerWarn = jest.fn()

jest.mock('@/lib/translations/translation-client-contract', () => ({
  requestBatchTranslation: (...args: unknown[]) => mockRequestBatchTranslation(...args),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf' }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}))

const POST_ID_1 = '11111111-1111-4111-8111-111111111111'
const POST_ID_2 = '22222222-2222-4222-8222-222222222222'

function post(id = POST_ID_1, overrides: Partial<Post> = {}): Post {
  return {
    id,
    group_id: '33333333-3333-4333-8333-333333333333',
    title: '完整标题，不得截断 '.repeat(12),
    content: '完整正文，不得截断 '.repeat(30),
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
    content_version: 1,
    ...overrides,
  }
}

function receipt(items: readonly BatchTranslationItem[], prefix = 'translated') {
  return {
    results: Object.fromEntries(
      items.map((item) => [item.id, { translatedText: `${prefix}:${item.text}`, cached: false }])
    ),
    total: items.length,
    cached: 0,
    translated: items.length,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const baseProps = {
  posts: [post()],
  language: 'en',
  ownerKey: 'group-owner-a',
  translatingEnabled: true,
  accessToken: 'token-a',
}

describe('group post translation loading truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequestBatchTranslation.mockImplementation(async (items: readonly BatchTranslationItem[]) =>
      receipt(items)
    )
  })

  it.each(['zh', 'en', 'ja', 'ko'] as const)(
    'sends exact full title/content to the shared contract for %s',
    async (language) => {
      const source = post()
      const { result } = renderHook(() =>
        usePostTranslation({ ...baseProps, posts: [source], language })
      )

      await waitFor(() => expect(result.current.translatingPosts).toBe(false))
      const [items, target, options] = mockRequestBatchTranslation.mock.calls[0] as [
        BatchTranslationItem[],
        string,
        { accessToken: string; csrfHeaders: Record<string, string>; signal: AbortSignal },
      ]
      expect(target).toBe(language)
      expect(items).toEqual([
        expect.objectContaining({
          id: `${POST_ID_1}-title`,
          text: source.title,
          targetLang: language,
        }),
        expect.objectContaining({
          id: `${POST_ID_1}-content`,
          text: source.content,
          targetLang: language,
        }),
      ])
      expect(options).toMatchObject({
        accessToken: 'token-a',
        csrfHeaders: { 'x-csrf-token': 'csrf' },
      })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(result.current.translatedPosts[POST_ID_1]).toEqual({
        title: `translated:${source.title}`,
        content: `translated:${source.content}`,
      })
    }
  )

  it('aborts and ignores a late same-id response after the source revision changes', async () => {
    const first = deferred<ReturnType<typeof receipt>>()
    mockRequestBatchTranslation
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async (items: readonly BatchTranslationItem[]) =>
        receipt(items, 'new')
      )

    const original = post()
    const revised = post(POST_ID_1, {
      title: 'revised title',
      content: 'revised content',
      content_version: 2,
      updated_at: '2026-08-03T00:01:00.000Z',
    })
    const { result, rerender } = renderHook(
      (props: typeof baseProps) => usePostTranslation(props),
      { initialProps: { ...baseProps, posts: [original] } }
    )
    await waitFor(() => expect(mockRequestBatchTranslation).toHaveBeenCalledTimes(1))
    const firstSignal = mockRequestBatchTranslation.mock.calls[0]?.[2].signal as AbortSignal

    rerender({ ...baseProps, posts: [revised] })
    await waitFor(() => expect(mockRequestBatchTranslation).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(result.current.translatedPosts[POST_ID_1]?.title).toBe('new:revised title')
    )
    expect(firstSignal.aborted).toBe(true)

    await act(async () => {
      first.resolve(receipt(mockRequestBatchTranslation.mock.calls[0]?.[0], 'old'))
      await first.promise
    })
    expect(result.current.translatedPosts[POST_ID_1]).toEqual({
      title: 'new:revised title',
      content: 'new:revised content',
    })
  })

  it('publishes no partial new scope until every bounded batch succeeds', async () => {
    const second = deferred<ReturnType<typeof receipt>>()
    mockRequestBatchTranslation
      .mockImplementationOnce(async (items: readonly BatchTranslationItem[]) =>
        receipt(items, 'first-batch')
      )
      .mockImplementationOnce(() => second.promise)
    const posts = Array.from({ length: 11 }, (_, index) =>
      post(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, {
        title: `title-${index}`,
        content: `content-${index}`,
      })
    )
    const { result } = renderHook(() => usePostTranslation({ ...baseProps, posts }))

    await waitFor(() => expect(mockRequestBatchTranslation).toHaveBeenCalledTimes(2))
    expect(mockRequestBatchTranslation.mock.calls[0]?.[0]).toHaveLength(20)
    expect(mockRequestBatchTranslation.mock.calls[1]?.[0]).toHaveLength(2)
    expect(result.current.translatedPosts).toEqual({})
    expect(result.current.translatingPosts).toBe(true)

    await act(async () => {
      const items = mockRequestBatchTranslation.mock.calls[1]?.[0] as BatchTranslationItem[]
      second.resolve(receipt(items, 'second-batch'))
      await second.promise
    })
    await waitFor(() => expect(result.current.translatingPosts).toBe(false))
    expect(Object.keys(result.current.translatedPosts)).toHaveLength(11)
  })

  it('preserves exact cached rows while a later appended-row translation fails', async () => {
    const { result, rerender } = renderHook(
      (props: typeof baseProps) => usePostTranslation(props),
      { initialProps: baseProps }
    )
    await waitFor(() => expect(result.current.translatedPosts[POST_ID_1]).toBeDefined())

    mockRequestBatchTranslation.mockRejectedValueOnce(new Error('translation unavailable'))
    rerender({ ...baseProps, posts: [baseProps.posts[0], post(POST_ID_2)] })

    await waitFor(() => expect(result.current.translatingPosts).toBe(false))
    expect(result.current.translatedPosts[POST_ID_1]).toBeDefined()
    expect(result.current.translatedPosts[POST_ID_2]).toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Group translation failed:',
      expect.objectContaining({ message: 'translation unavailable' })
    )
  })

  it('reuses exact owner-scoped cache after a token refresh', async () => {
    const { result, rerender } = renderHook(
      (props: typeof baseProps) => usePostTranslation(props),
      { initialProps: baseProps }
    )
    await waitFor(() => expect(result.current.translatedPosts[POST_ID_1]).toBeDefined())
    expect(mockRequestBatchTranslation).toHaveBeenCalledTimes(1)

    rerender({ ...baseProps, accessToken: 'token-refreshed' })

    await waitFor(() => expect(result.current.translatingPosts).toBe(false))
    expect(mockRequestBatchTranslation).toHaveBeenCalledTimes(1)
    expect(result.current.translatedPosts[POST_ID_1]?.title).toBe(
      `translated:${baseProps.posts[0].title}`
    )
  })

  it('aborts in-flight work on unmount and never publishes it', async () => {
    const pending = deferred<ReturnType<typeof receipt>>()
    mockRequestBatchTranslation.mockReturnValueOnce(pending.promise)
    const { unmount } = renderHook(() => usePostTranslation(baseProps))

    await waitFor(() => expect(mockRequestBatchTranslation).toHaveBeenCalledTimes(1))
    const signal = mockRequestBatchTranslation.mock.calls[0]?.[2].signal as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)

    await act(async () => {
      pending.resolve(receipt(mockRequestBatchTranslation.mock.calls[0]?.[0], 'late'))
      await pending.promise
    })
  })

  it('does not request personalized translation without an exact token scope', () => {
    const { result } = renderHook(() => usePostTranslation({ ...baseProps, accessToken: null }))
    expect(mockRequestBatchTranslation).not.toHaveBeenCalled()
    expect(result.current).toEqual({ translatedPosts: {}, translatingPosts: false })
  })
})
