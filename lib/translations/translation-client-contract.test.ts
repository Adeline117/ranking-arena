import {
  readBatchTranslationResponse,
  readSingleTranslationResponse,
  requestBatchTranslation,
  requestSingleTranslation,
  TRANSLATION_REQUEST_TIMEOUT_MS,
  type BatchTranslationItem,
} from './translation-client-contract'
import { TRANSLATION_SERVER_REQUEST_TIMEOUT_MS } from './translation-server-contract'
import {
  TRANSLATION_MAX_BATCH_ITEMS,
  TRANSLATION_MAX_BATCH_TEXT_LENGTH,
  TRANSLATION_MAX_OUTPUT_TEXT_LENGTH,
  TRANSLATION_MAX_TEXT_LENGTH,
} from './translation-limits'

const singleRequest = {
  text: '交易策略',
  targetLang: 'en' as const,
  contentType: 'post_content' as const,
  contentId: 'post-1',
}

const batchItems: BatchTranslationItem[] = [
  {
    id: 'item-0',
    text: '标题',
    targetLang: 'en',
    contentType: 'post_title',
    contentId: 'post_with_underscore',
  },
  {
    id: 'item-1',
    text: '正文',
    targetLang: 'en',
    contentType: 'post_content',
    contentId: 'post_with_underscore',
  },
]

function response(body: unknown, json?: () => Promise<unknown>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: json ?? (async () => body),
  } as Response
}

function singleEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      translatedText: 'Trading strategy',
      originalText: singleRequest.text,
      targetLang: singleRequest.targetLang,
      cached: false,
      ...overrides,
    },
  }
}

function batchEnvelope(
  results: Record<string, unknown> = {
    'item-0': { translatedText: 'Title', cached: true },
    'item-1': { translatedText: 'Body', cached: false },
  },
  overrides: Record<string, unknown> = {}
) {
  return {
    success: true,
    data: {
      results,
      total: 2,
      cached: 1,
      translated: 1,
      ...overrides,
    },
  }
}

describe('translation client contract', () => {
  it('keeps the client deadline beyond the server-owned deadline', () => {
    expect(TRANSLATION_REQUEST_TIMEOUT_MS).toBeGreaterThan(TRANSLATION_SERVER_REQUEST_TIMEOUT_MS)
  })

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

  it('binds a single receipt to the exact source and target language', () => {
    expect(readSingleTranslationResponse(singleEnvelope(), singleRequest)).toEqual({
      translatedText: 'Trading strategy',
      cached: false,
      sameLanguage: false,
    })
    expect(
      readSingleTranslationResponse(singleEnvelope({ originalText: '别的原文' }), singleRequest)
    ).toBeNull()
    expect(
      readSingleTranslationResponse(singleEnvelope({ targetLang: 'zh' }), singleRequest)
    ).toBeNull()
    expect(
      readSingleTranslationResponse({ ...singleEnvelope(), extra: true }, singleRequest)
    ).toBeNull()
  })

  it('accepts only an explicitly marked same-language source echo', () => {
    expect(
      readSingleTranslationResponse(
        singleEnvelope({ translatedText: singleRequest.text, sameLanguage: true, cached: true }),
        singleRequest
      )
    ).toMatchObject({ sameLanguage: true })
    expect(
      readSingleTranslationResponse(
        singleEnvelope({ translatedText: singleRequest.text }),
        singleRequest
      )
    ).toBeNull()
    expect(
      readSingleTranslationResponse(
        singleEnvelope({ translatedText: 'Trading strategy', sameLanguage: true }),
        singleRequest
      )
    ).toBeNull()
  })

  it('accepts legitimate output expansion while preserving a finite output cap', () => {
    const expandedTranslation = 'T'.repeat(TRANSLATION_MAX_TEXT_LENGTH + 1)
    expect(expandedTranslation.length).toBeLessThanOrEqual(TRANSLATION_MAX_OUTPUT_TEXT_LENGTH)
    expect(
      readSingleTranslationResponse(
        singleEnvelope({ translatedText: expandedTranslation }),
        singleRequest
      )
    ).toMatchObject({ translatedText: expandedTranslation, sameLanguage: false })
    expect(
      readSingleTranslationResponse(
        singleEnvelope({ translatedText: 'T'.repeat(TRANSLATION_MAX_OUTPUT_TEXT_LENGTH + 1) }),
        singleRequest
      )
    ).toBeNull()
  })

  it.each(['ja', 'ko'] as const)(
    'binds supported %s targets without weakening identity checks',
    (targetLang) => {
      const request = { ...singleRequest, targetLang }
      expect(
        readSingleTranslationResponse(
          singleEnvelope({
            targetLang,
            translatedText: targetLang === 'ja' ? '取引戦略' : '거래 전략',
          }),
          request
        )
      ).toMatchObject({ sameLanguage: false })
      expect(
        readSingleTranslationResponse(singleEnvelope({ targetLang: 'fr' }), request)
      ).toBeNull()
      expect(
        readSingleTranslationResponse(singleEnvelope({ targetLang: 'fr' }), {
          ...request,
          targetLang: 'fr' as never,
        })
      ).toBeNull()
    }
  )

  it('accepts complete Japanese and Korean batches under the same exact-ID contract', () => {
    for (const targetLang of ['ja', 'ko'] as const) {
      const items = batchItems.map((item) => ({ ...item, targetLang }))
      expect(readBatchTranslationResponse(batchEnvelope(), items)).toMatchObject({ total: 2 })
    }
  })

  it('accepts a batch only when every requested ID has one exact result', () => {
    expect(readBatchTranslationResponse(batchEnvelope(), batchItems)).toMatchObject({ total: 2 })
    expect(
      readBatchTranslationResponse(
        batchEnvelope({ 'item-0': { translatedText: 'Title', cached: true } }),
        batchItems
      )
    ).toBeNull()
    expect(
      readBatchTranslationResponse(
        batchEnvelope({
          'item-0': { translatedText: 'Title', cached: true },
          'item-1': { translatedText: 'Body', cached: false },
          unexpected: { translatedText: 'Injected', cached: false },
        }),
        batchItems
      )
    ).toBeNull()
  })

  it('accepts expanded output in a complete batch receipt', () => {
    const expandedTranslation = 'T'.repeat(TRANSLATION_MAX_TEXT_LENGTH + 1)
    expect(
      readBatchTranslationResponse(
        batchEnvelope({
          'item-0': { translatedText: expandedTranslation, cached: true },
          'item-1': { translatedText: 'Body', cached: false },
        }),
        batchItems
      )
    ).toMatchObject({
      results: { 'item-0': { translatedText: expandedTranslation, cached: true } },
    })
  })

  it.each([
    ['wrong total', { total: 1 }],
    ['impossible counters', { cached: 2, translated: 1 }],
    ['negative counter', { cached: -1, translated: 3 }],
    ['extra data field', { partial: true }],
  ])('rejects batch metadata with %s', (_label, overrides) => {
    expect(readBatchTranslationResponse(batchEnvelope(undefined, overrides), batchItems)).toBeNull()
  })

  it('rejects duplicate request IDs before accepting a response', () => {
    expect(
      readBatchTranslationResponse(batchEnvelope(), [
        batchItems[0],
        { ...batchItems[1], id: 'item-0' },
      ])
    ).toBeNull()
  })

  it('rejects oversized client work before making a network request', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>

    await expect(
      requestSingleTranslation(
        { ...singleRequest, text: 'x'.repeat(TRANSLATION_MAX_TEXT_LENGTH + 1) },
        { accessToken: 'token-a' }
      )
    ).rejects.toThrow('outside the admitted limits')
    await expect(
      requestBatchTranslation(
        Array.from({ length: 5 }, (_value, index) => ({
          ...batchItems[0],
          id: `item-${index}`,
          contentId: `post-${index}`,
          text: 'x'.repeat(TRANSLATION_MAX_BATCH_TEXT_LENGTH / 5 + 1),
        })),
        'en',
        { accessToken: 'token-a' }
      )
    ).rejects.toThrow('outside the admitted limits')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('physically bounds a single fetch that ignores AbortSignal', async () => {
    jest.useFakeTimers()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockReturnValue(new Promise(() => undefined))

    const rejection = expect(
      requestSingleTranslation(singleRequest, { accessToken: 'token-a' })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
    await rejection
  })

  it('uses the same hard deadline for a stuck batch JSON decoder', async () => {
    jest.useFakeTimers()
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock.mockResolvedValue(response(null, () => new Promise(() => undefined)))

    const rejection = expect(
      requestBatchTranslation(batchItems, 'en', { accessToken: 'token-a' })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    await jest.advanceTimersByTimeAsync(TRANSLATION_REQUEST_TIMEOUT_MS)
    await rejection
  })

  it('posts no-store authenticated requests and validates the consumed body', async () => {
    const fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>
    fetchMock
      .mockResolvedValueOnce(response(singleEnvelope()))
      .mockResolvedValueOnce(response(batchEnvelope()))

    await expect(
      requestSingleTranslation(singleRequest, {
        accessToken: 'token-a',
        csrfHeaders: { 'x-csrf-token': 'csrf-a' },
      })
    ).resolves.toMatchObject({ translatedText: 'Trading strategy' })
    await expect(
      requestBatchTranslation(batchItems, 'en', { accessToken: 'token-a' })
    ).resolves.toMatchObject({ total: 2 })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/translate',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
        signal: expect.any(AbortSignal),
      })
    )
  })
})
