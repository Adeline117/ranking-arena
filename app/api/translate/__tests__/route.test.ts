/** @jest-environment node */

import { createHash } from 'crypto'

const mockRequireAuth = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()
const mockSingleCacheQuery = jest.fn()
const mockBatchCacheQuery = jest.fn()
const mockUpsertQuery = jest.fn()
const mockEq = jest.fn()
const mockIn = jest.fn()
const mockDatabaseAbortSignal = jest.fn()

jest.mock('@/lib/api', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getSupabaseAdmin: () => ({ from: (...args: unknown[]) => mockFrom(...args) }),
  RateLimitPresets: { authenticated: {} },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
}))

import type { NextRequest } from 'next/server'
import {
  readBatchTranslationResponse,
  readSingleTranslationResponse,
  type BatchTranslationItem,
} from '@/lib/translations/translation-client-contract'
import {
  TRANSLATION_GPT_CHUNK_MAX_OUTPUT_TOKENS,
  TRANSLATION_MAX_BATCH_ITEMS,
  TRANSLATION_MAX_PROVIDER_RESPONSE_BYTES,
  TRANSLATION_MAX_REQUEST_BYTES,
  splitTranslationText,
} from '@/lib/translations/translation-server-contract'
import { GET, POST } from '../route'

const originalFetch = globalThis.fetch
const originalOpenAiKey = process.env.OPENAI_API_KEY
const mockFetch = jest.fn()

const singleBody = {
  text: '交易策略',
  targetLang: 'en' as const,
  contentType: 'post_content' as const,
  contentId: 'post-1',
}

function batchItem(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `item-${index}`,
    text: `内容 ${index}`,
    contentType: 'post_content',
    contentId: `post-${index}`,
    ...overrides,
  }
}

function request(
  value: unknown = singleBody,
  options: { headers?: Record<string, string>; signal?: AbortSignal; raw?: boolean } = {}
): NextRequest {
  return new Request('https://www.arenafi.org/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.raw ? String(value) : JSON.stringify(value),
    signal: options.signal,
  }) as NextRequest
}

function googleResponse(
  translatedText = 'Trading strategy',
  detectedSource = 'zh-CN',
  sourceText = singleBody.text
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => [[[translatedText, sourceText]], null, detectedSource],
  } as Response
}

function googleRequestParams(call: unknown[]): URLSearchParams {
  const [input, init] = call as [string | URL | Request, RequestInit]
  expect(String(input)).toBe('https://translate.googleapis.com/translate_a/single')
  expect(init.method).toBe('POST')
  expect(init.headers).toEqual({
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  })
  return new URLSearchParams(String(init.body))
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Pragma')).toBe('no-cache')
  expect(response.headers.get('Vary')).toContain('Authorization')
  expect(response.headers.get('Vary')).toContain('Cookie')
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

function installSupabaseBuilder(): void {
  mockFrom.mockImplementation(() => ({
    select: jest.fn(() => {
      const builder: Record<string, unknown> & {
        eq: (column: string, value: unknown) => unknown
        in: (column: string, values: unknown[]) => unknown
        abortSignal: (signal: AbortSignal) => unknown
        maybeSingle: () => unknown
        then: PromiseLike<unknown>['then']
      } = {
        eq(column: string, value: unknown) {
          mockEq(column, value)
          return builder
        },
        in(column: string, values: unknown[]) {
          mockIn(column, values)
          return builder
        },
        abortSignal(signal: AbortSignal) {
          mockDatabaseAbortSignal(signal)
          return builder
        },
        maybeSingle() {
          return mockSingleCacheQuery()
        },
        then(resolve, reject) {
          return Promise.resolve(mockBatchCacheQuery()).then(resolve, reject)
        },
      }
      return builder
    }),
    upsert: jest.fn((rows: unknown, options: unknown) => ({
      abortSignal: (signal: AbortSignal) => mockUpsertQuery(rows, options, signal),
    })),
  }))
}

async function waitForCalls(mock: jest.Mock, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (mock.mock.calls.length >= expected) return
    await Promise.resolve()
  }
  throw new Error(`Expected ${expected} calls, received ${mock.mock.calls.length}`)
}

describe('/api/translate server truth boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: 'user-1' })
    mockCheckRateLimit.mockResolvedValue(null)
    mockSingleCacheQuery.mockResolvedValue({ data: null, error: null })
    mockBatchCacheQuery.mockResolvedValue({ data: [], error: null })
    mockUpsertQuery.mockResolvedValue({ error: null })
    mockFetch.mockImplementation(async (...call: unknown[]) => {
      const sourceText = googleRequestParams(call).get('q') ?? ''
      return googleResponse('Trading strategy', 'zh-CN', sourceText)
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: mockFetch,
      writable: true,
    })
    delete process.env.OPENAI_API_KEY
    installSupabaseBuilder()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAiKey
  })

  afterAll(() => {
    if (originalFetch) {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: originalFetch,
        writable: true,
      })
    }
  })

  it('returns an exact same-language single receipt without cache or external work', async () => {
    const input = {
      text: 'Bitcoin rallied',
      targetLang: 'en' as const,
      contentType: 'post_content' as const,
      contentId: 'post-1',
    }

    const response = await POST(request(input))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(readSingleTranslationResponse(payload, input)).toEqual({
      translatedText: input.text,
      cached: true,
      sameLanguage: true,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('uses provider detection before treating Han-only text as the target language', async () => {
    const chinese = {
      text: '交易策略',
      targetLang: 'zh' as const,
      contentType: 'post_content' as const,
      contentId: 'post-zh',
    }
    mockFetch.mockResolvedValueOnce(googleResponse(chinese.text, 'zh-CN', chinese.text))

    const sameLanguageResponse = await POST(request(chinese))
    const sameLanguagePayload = await sameLanguageResponse.json()

    expect(readSingleTranslationResponse(sameLanguagePayload, chinese)).toEqual({
      translatedText: chinese.text,
      cached: true,
      sameLanguage: true,
    })
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expect(googleRequestParams(mockFetch.mock.calls[0]).get('sl')).toBe('auto')

    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: 'user-1' })
    mockCheckRateLimit.mockResolvedValue(null)
    mockSingleCacheQuery.mockResolvedValue({ data: null, error: null })
    mockUpsertQuery.mockResolvedValue({ error: null })
    installSupabaseBuilder()
    const japanese = { ...chinese, text: '仮想通貨市場', contentId: 'post-ja' }
    mockFetch.mockResolvedValueOnce(googleResponse('加密货币市场', 'ja', japanese.text))

    const translatedResponse = await POST(request(japanese))
    const translatedPayload = await translatedResponse.json()

    expect(readSingleTranslationResponse(translatedPayload, japanese)).toEqual({
      translatedText: '加密货币市场',
      cached: false,
      sameLanguage: false,
    })
    expect(googleRequestParams(mockFetch.mock.calls[0]).get('sl')).toBe('auto')
    expect(String(mockFetch.mock.calls[0][0])).not.toContain(japanese.text)
  })

  it('keeps flash_news as a valid cache namespace', async () => {
    const input = {
      items: [batchItem(1, { contentType: 'flash_news', contentId: 'news-1' })],
      targetLang: 'en',
    }

    const response = await POST(request(input))

    expect(response.status).toBe(200)
    expect(mockEq).toHaveBeenCalledWith('content_type', 'flash_news')
    expect(mockUpsertQuery).toHaveBeenCalledWith(
      [expect.objectContaining({ content_type: 'flash_news', content_id: 'news-1' })],
      { onConflict: 'content_type,content_id,target_lang' },
      expect.any(AbortSignal)
    )
  })

  it('returns all 20 admitted items without silently slicing the batch', async () => {
    const items = Array.from({ length: TRANSLATION_MAX_BATCH_ITEMS }, (_value, index) =>
      batchItem(index, { text: `Already English ${index}` })
    )

    const response = await POST(request({ items, targetLang: 'en' }))
    const payload = await response.json()
    const expectedItems: BatchTranslationItem[] = items.map((item) => ({
      ...item,
      targetLang: 'en',
      contentType: 'post_content',
    }))

    expect(response.status).toBe(200)
    expect(readBatchTranslationResponse(payload, expectedItems)).toMatchObject({
      total: 20,
      cached: 20,
      translated: 0,
    })
    expect(Object.keys(payload.data.results)).toHaveLength(20)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2)
    expect(mockCheckRateLimit.mock.calls[1][3]).toBe(TRANSLATION_MAX_BATCH_ITEMS)
  })

  it.each([
    ['unsupported media type', singleBody, { 'content-type': 'text/plain' }, 415],
    ['wrong target', { ...singleBody, targetLang: 'fr' }, undefined, 400],
    ['missing source identity', { ...singleBody, contentId: undefined }, undefined, 400],
    ['extra single field', { ...singleBody, invented: true }, undefined, 400],
    ['empty batch', { items: [], targetLang: 'en' }, undefined, 400],
    [
      '21-item batch',
      {
        items: Array.from({ length: TRANSLATION_MAX_BATCH_ITEMS + 1 }, (_value, index) =>
          batchItem(index)
        ),
        targetLang: 'en',
      },
      undefined,
      400,
    ],
    [
      'duplicate item IDs',
      { items: [batchItem(1), batchItem(2, { id: 'item-1' })], targetLang: 'en' },
      undefined,
      400,
    ],
    [
      'duplicate content identity',
      { items: [batchItem(1), batchItem(2, { contentId: 'post-1' })], targetLang: 'en' },
      undefined,
      400,
    ],
    [
      'incomplete item',
      { items: [batchItem(1, { text: undefined })], targetLang: 'en' },
      undefined,
      400,
    ],
    [
      'extra item field',
      { items: [batchItem(1, { invented: true })], targetLang: 'en' },
      undefined,
      400,
    ],
    [
      'prototype-key item ID',
      { items: [batchItem(1, { id: '__proto__' })], targetLang: 'en' },
      undefined,
      400,
    ],
    [
      'constructor content identity',
      { items: [batchItem(1, { contentId: 'constructor' })], targetLang: 'en' },
      undefined,
      400,
    ],
  ])('rejects %s without cache or translation work', async (_label, value, headers, status) => {
    const response = await POST(request(value, { headers }))

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('rejects a physically oversized body instead of parsing it', async () => {
    const response = await POST(
      request('{}', {
        raw: true,
        headers: { 'content-length': String(TRANSLATION_MAX_REQUEST_BYTES + 1) },
      })
    )

    expect(response.status).toBe(413)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects an oversized provider body before decoding or caching it', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(TRANSLATION_MAX_PROVIDER_RESPONSE_BYTES + 1),
        },
      })
    )

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it.each([
    [
      'malformed segment',
      [[['Trading ', '交易'], { translated: 'strategy', source: '策略' }], null, 'zh-CN'],
    ],
    [
      'mismatched source reconstruction',
      [[['Trading strategy', 'different source']], null, 'zh-CN'],
    ],
  ])(
    'rejects a Google response with a %s instead of caching partial output',
    async (_label, body) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => body,
      } as Response)

      const response = await POST(request())

      expect(response.status).toBe(502)
      expect(mockUpsertQuery).not.toHaveBeenCalled()
      expectPrivateNoStore(response)
    }
  )

  it('returns only a hash-bound single cache hit', async () => {
    mockSingleCacheQuery.mockResolvedValue({
      data: {
        content_type: singleBody.contentType,
        content_id: singleBody.contentId,
        content_hash: contentHash(singleBody.text),
        source_lang: 'unknown',
        target_lang: singleBody.targetLang,
        translated_text: 'Trading strategy',
      },
      error: null,
    })

    const response = await POST(request())
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(readSingleTranslationResponse(payload, singleBody)).toMatchObject({
      translatedText: 'Trading strategy',
      cached: true,
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockUpsertQuery).not.toHaveBeenCalled()
  })

  it('fails closed on a hash-matching cache row for another content identity', async () => {
    mockSingleCacheQuery.mockResolvedValue({
      data: {
        content_type: singleBody.contentType,
        content_id: 'post-other',
        content_hash: contentHash(singleBody.text),
        source_lang: 'unknown',
        target_lang: singleBody.targetLang,
        translated_text: 'Trading strategy',
      },
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockUpsertQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['content namespace', { content_type: 'comment' }],
    ['target language', { target_lang: 'ja' }],
  ])('fails closed on a cache row with the wrong %s', async (_label, override) => {
    mockSingleCacheQuery.mockResolvedValue({
      data: {
        content_type: singleBody.contentType,
        content_id: singleBody.contentId,
        content_hash: contentHash(singleBody.text),
        source_lang: 'unknown',
        target_lang: singleBody.targetLang,
        translated_text: 'Trading strategy',
        ...override,
      },
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockUpsertQuery).not.toHaveBeenCalled()
  })

  it('derives batch counters from exact hash hits, identity results and fresh translations', async () => {
    const items = [
      batchItem(0, { text: '标题', contentId: 'post-title' }),
      batchItem(1, { text: '正文', contentId: 'post-body' }),
      batchItem(2, { text: 'Already English', contentId: 'post-english' }),
    ]
    mockBatchCacheQuery.mockResolvedValue({
      data: [
        {
          content_type: 'post_content',
          content_id: 'post-title',
          content_hash: contentHash('标题'),
          source_lang: 'unknown',
          target_lang: 'en',
          translated_text: 'Cached title',
        },
        {
          content_type: 'post_content',
          content_id: 'post-body',
          content_hash: '0'.repeat(32),
          source_lang: 'unknown',
          target_lang: 'en',
          translated_text: 'Stale body',
        },
      ],
      error: null,
    })
    mockFetch.mockResolvedValue(googleResponse('Fresh body', 'zh-CN', '正文'))

    const response = await POST(request({ items, targetLang: 'en' }))
    const payload = await response.json()
    const expectedItems: BatchTranslationItem[] = items.map((item) => ({
      ...item,
      targetLang: 'en',
      contentType: 'post_content',
    }))

    expect(response.status).toBe(200)
    expect(readBatchTranslationResponse(payload, expectedItems)).toMatchObject({
      total: 3,
      cached: 2,
      translated: 1,
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockUpsertQuery).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          content_id: 'post-body',
          content_hash: contentHash('正文'),
          translated_text: 'Fresh body',
        }),
      ],
      expect.anything(),
      expect.any(AbortSignal)
    )
  })

  it('uses detected Japanese and Korean sources when translating to English', async () => {
    const items = [
      batchItem(1, { text: 'ビットコインが上昇', contentId: 'post-ja' }),
      batchItem(2, { text: '비트코인이 상승', contentId: 'post-ko' }),
    ]
    mockFetch.mockImplementation(async (...call: unknown[]) => {
      const source = googleRequestParams(call).get('sl')
      const sourceText = googleRequestParams(call).get('q') ?? ''
      return googleResponse(
        source === 'ja' ? 'Japanese translation' : 'Korean translation',
        source ?? 'unknown',
        sourceText
      )
    })

    const response = await POST(request({ items, targetLang: 'en' }))

    expect(response.status).toBe(200)
    const sources = mockFetch.mock.calls.map((call) => googleRequestParams(call).get('sl'))
    expect(sources).toEqual(expect.arrayContaining(['ja', 'ko']))
    expect(sources).not.toContain('zh-CN')
  })

  it('uses Google auto-detection for ambiguous and script-free sources', async () => {
    const items = [
      batchItem(1, { text: '比特币BTC', contentId: 'post-mixed' }),
      batchItem(2, { text: '🚀 12345 $', contentId: 'post-symbols' }),
    ]
    mockFetch.mockImplementation(async (...call: unknown[]) => {
      const sourceText = googleRequestParams(call).get('q') ?? ''
      return googleResponse('Detected translation', 'zh-CN', sourceText)
    })

    const response = await POST(request({ items, targetLang: 'en' }))

    expect(response.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const call of mockFetch.mock.calls) {
      expect(googleRequestParams(call).get('sl')).toBe('auto')
    }
  })

  it('fails closed when a cache read returns an error', async () => {
    mockSingleCacheQuery.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'cache unavailable' },
    })

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Translation cache unavailable',
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it.each([
    ['an explicit error', { data: null, error: { code: 'XX000', message: 'failed' } }],
    ['a malformed empty result', { data: null, error: null }],
  ])('fails a batch on %s from its cache query', async (_label, cacheResult) => {
    mockBatchCacheQuery.mockResolvedValue(cacheResult)

    const response = await POST(request({ items: [batchItem(1), batchItem(2)], targetLang: 'en' }))

    expect(response.status).toBe(503)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('awaits cache persistence and fails closed when the upsert errors', async () => {
    mockFetch.mockResolvedValue(googleResponse('Fresh translation'))
    mockUpsertQuery.mockResolvedValue({
      error: { code: 'XX000', message: 'cache write failed' },
    })

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Translation cache unavailable',
    })
    expect(mockUpsertQuery).toHaveBeenCalledTimes(1)
  })

  it('returns a non-2xx batch failure and writes no partial cache when one item fails', async () => {
    mockFetch
      .mockResolvedValueOnce(googleResponse('First translation', 'zh-CN', '内容 1'))
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
    const items = [batchItem(1), batchItem(2)]

    const response = await POST(request({ items, targetLang: 'en' }))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Translation failed',
    })
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('aborts pending sibling translations as soon as one batch item fails', async () => {
    let siblingSignal: AbortSignal | undefined
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockImplementationOnce((_input: string | URL | Request, init?: RequestInit) => {
        siblingSignal = init?.signal as AbortSignal | undefined
        return new Promise(() => undefined)
      })

    const response = await POST(request({ items: [batchItem(1), batchItem(2)], targetLang: 'en' }))

    expect(response.status).toBe(502)
    expect(siblingSignal?.aborted).toBe(true)
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('accepts only a complete GPT fallback and persists its exact result', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 } as Response).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'Complete trading strategy' },
          },
        ],
      }),
    } as Response)

    const response = await POST(request())
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(readSingleTranslationResponse(payload, singleBody)).toMatchObject({
      translatedText: 'Complete trading strategy',
      cached: false,
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const openAiRequest = JSON.parse(String(mockFetch.mock.calls[1][1]?.body))
    expect(openAiRequest).toMatchObject({
      model: 'gpt-4o-mini',
      store: false,
      max_completion_tokens: TRANSLATION_GPT_CHUNK_MAX_OUTPUT_TOKENS,
    })
    expect(openAiRequest).not.toHaveProperty('max_tokens')
    expect(mockUpsertQuery).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          content_type: singleBody.contentType,
          content_id: singleBody.contentId,
          translated_text: 'Complete trading strategy',
        }),
      ],
      { onConflict: 'content_type,content_id,target_lang' },
      expect.any(AbortSignal)
    )
    expectPrivateNoStore(response)
  })

  it('translates a long GPT fallback in one concurrent bounded chunk wave', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    const input = {
      text: 'Trading strategy and risk controls. '.repeat(100),
      targetLang: 'ja' as const,
      contentType: 'post_content' as const,
      contentId: 'post-long',
    }
    const chunks = splitTranslationText(input.text)
    expect(chunks.length).toBeGreaterThan(1)

    mockFetch.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('translate.googleapis.com')) {
        return { ok: false, status: 502 } as Response
      }
      const body = JSON.parse(String(init?.body))
      const sourceText = body.messages[1].content as string
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content: `訳:${sourceText}` } }],
        }),
      } as Response
    })

    const response = await POST(request(input))
    const payload = await response.json()
    const expected = chunks.map((chunk) => `訳:${chunk.text}${chunk.suffix}`).join('')

    expect(response.status).toBe(200)
    expect(readSingleTranslationResponse(payload, input)).toMatchObject({
      translatedText: expected,
      cached: false,
    })
    expect(mockFetch).toHaveBeenCalledTimes(1 + chunks.length)
    expect(mockCheckRateLimit.mock.calls[2][3]).toBe(chunks.length)
    expect(mockUpsertQuery).toHaveBeenCalledWith(
      [expect.objectContaining({ content_id: input.contentId, translated_text: expected })],
      expect.anything(),
      expect.any(AbortSignal)
    )
  })

  it('aborts sibling GPT chunks and writes no cache when one chunk is incomplete', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    const input = {
      text: 'Trading strategy and risk controls. '.repeat(100),
      targetLang: 'ja' as const,
      contentType: 'post_content' as const,
      contentId: 'post-long-failure',
    }
    let openAiCalls = 0
    const siblingSignals: AbortSignal[] = []
    mockFetch.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('translate.googleapis.com')) {
        return Promise.resolve({ ok: false, status: 502 } as Response)
      }
      openAiCalls += 1
      if (openAiCalls === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
          }),
        } as Response)
      }
      siblingSignals.push(init?.signal as AbortSignal)
      return new Promise(() => undefined)
    })

    const response = await POST(request(input))

    expect(response.status).toBe(502)
    expect(siblingSignals.length).toBeGreaterThan(0)
    expect(siblingSignals.every((signal) => signal.aborted)).toBe(true)
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('enforces a separate fail-closed GPT fallback budget', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    mockCheckRateLimit
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Response.json({ error: 'GPT quota exhausted' }, { status: 429 }))
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 } as Response)

    const response = await POST(request())

    expect(response.status).toBe(429)
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(3)
    expect(mockCheckRateLimit.mock.calls[2][1]).toMatchObject({
      requests: 120,
      prefix: 'translation-gpt',
      failClose: true,
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('rejects a GPT response truncated by its output limit', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502 } as Response).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            finish_reason: 'length',
            message: { content: 'Partial translation' },
          },
        ],
      }),
    } as Response)

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockUpsertQuery).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it.each(['fetch', 'json body'])(
    'bounds a stuck Google %s with its independent deadline',
    async (stuckAt) => {
      const requestDeadline = new AbortController()
      const googleDeadline = new AbortController()
      jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValueOnce(requestDeadline.signal)
        .mockReturnValueOnce(googleDeadline.signal)

      if (stuckAt === 'fetch') {
        mockFetch.mockReturnValue(new Promise(() => undefined))
      } else {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          json: () => new Promise(() => undefined),
        } as Response)
      }

      const pending = POST(request())
      await waitForCalls(mockFetch, 1)
      googleDeadline.abort(new DOMException('Google deadline', 'TimeoutError'))
      const response = await pending

      expect(response.status).toBe(502)
      expectPrivateNoStore(response)
    }
  )

  it.each(['fetch', 'json body'])(
    'bounds a stuck GPT %s with its independent deadline',
    async (stuckAt) => {
      process.env.OPENAI_API_KEY = 'test-openai-key'
      const requestDeadline = new AbortController()
      const googleDeadline = new AbortController()
      const gptDeadline = new AbortController()
      jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValueOnce(requestDeadline.signal)
        .mockReturnValueOnce(googleDeadline.signal)
        .mockReturnValueOnce(gptDeadline.signal)
      mockFetch.mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      if (stuckAt === 'fetch') {
        mockFetch.mockReturnValueOnce(new Promise(() => undefined))
      } else {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => new Promise(() => undefined),
        } as Response)
      }

      const pending = POST(request())
      await waitForCalls(mockFetch, 2)
      gptDeadline.abort(new DOMException('GPT deadline', 'TimeoutError'))
      const response = await pending

      expect(response.status).toBe(502)
      expectPrivateNoStore(response)
    }
  )

  it('cancels a dependency that ignores the caller request signal', async () => {
    const controller = new AbortController()
    mockSingleCacheQuery.mockReturnValue(new Promise(() => undefined))

    const pending = POST(request(singleBody, { signal: controller.signal }))
    await waitForCalls(mockSingleCacheQuery, 1)
    controller.abort(new DOMException('Client disconnected', 'AbortError'))
    const response = await pending

    expect(response.status).toBe(503)
    expect(mockFetch).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('enforces the whole-request server deadline when a dependency ignores its signal', async () => {
    const requestDeadline = new AbortController()
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(requestDeadline.signal)
    mockSingleCacheQuery.mockReturnValue(new Promise(() => undefined))

    const pending = POST(request())
    await waitForCalls(mockSingleCacheQuery, 1)
    requestDeadline.abort(new DOMException('Request deadline', 'TimeoutError'))
    const response = await pending

    expect(response.status).toBe(503)
    expect(mockFetch).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('wraps authentication, rate-limit and GET responses in the private cache boundary', async () => {
    mockRequireAuth.mockRejectedValueOnce(new Error('unauthorized'))
    const unauthorized = await POST(request())
    expect(unauthorized.status).toBe(401)
    expectPrivateNoStore(unauthorized)

    mockRequireAuth.mockResolvedValue({ id: 'user-1' })
    mockCheckRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'Too many requests' }, { status: 429 })
    )
    const limitedRequest = request()
    const limited = await POST(limitedRequest)
    expect(limited.status).toBe(429)
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      limitedRequest,
      {
        requests: 60,
        window: 60,
        prefix: 'translation-request',
        failClose: true,
      },
      'user-1',
      1
    )
    expectPrivateNoStore(limited)

    const get = await GET()
    expect(get.status).toBe(405)
    expectPrivateNoStore(get)
  })

  it('charges one fail-closed item-limit unit per admitted batch item', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Response.json({ error: 'Item quota exhausted' }, { status: 429 }))

    const response = await POST(request({ items: [batchItem(1), batchItem(2)], targetLang: 'en' }))

    expect(response.status).toBe(429)
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2)
    expect(mockCheckRateLimit.mock.calls[1][1]).toMatchObject({
      requests: 120,
      prefix: 'translation-item',
      failClose: true,
    })
    expect(mockCheckRateLimit.mock.calls[1][3]).toBe(2)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('fails closed in production when the distributed limiter is not configured', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousRedisUrl = process.env.UPSTASH_REDIS_REST_URL
    const previousRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN
    process.env.NODE_ENV = 'production'
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN

    try {
      const response = await POST(request())

      expect(response.status).toBe(503)
      expect(mockCheckRateLimit).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockFetch).not.toHaveBeenCalled()
      expectPrivateNoStore(response)
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      if (previousRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
      else process.env.UPSTASH_REDIS_REST_URL = previousRedisUrl
      if (previousRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
      else process.env.UPSTASH_REDIS_REST_TOKEN = previousRedisToken
    }
  })

  it('maps rate-limit exceptions and deadline expiry to private 503 responses', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('limiter unavailable'))
    const failed = await POST(request())
    expect(failed.status).toBe(503)
    expectPrivateNoStore(failed)

    const requestDeadline = new AbortController()
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(requestDeadline.signal)
    mockCheckRateLimit.mockReturnValueOnce(new Promise(() => undefined))
    const pending = POST(request())
    await waitForCalls(mockCheckRateLimit, 2)
    requestDeadline.abort(new DOMException('Request deadline', 'TimeoutError'))
    const expired = await pending

    expect(expired.status).toBe(503)
    expectPrivateNoStore(expired)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
