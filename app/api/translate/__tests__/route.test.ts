/** @jest-environment node */
const mockUpsert = jest.fn()
const mockLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    error: (...a: unknown[]) => mockLogger.error(...a),
    warn: (...a: unknown[]) => mockLogger.warn(...a),
    info: (...a: unknown[]) => mockLogger.info(...a),
    debug: (...a: unknown[]) => mockLogger.debug(...a),
  })),
}))

const cacheQuery = {
  select: jest.fn(() => cacheQuery),
  eq: jest.fn(() => cacheQuery),
  in: jest.fn(() => Promise.resolve({ data: [], error: null })),
  maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
  upsert: (...args: unknown[]) => mockUpsert(...args),
}

jest.mock('@/lib/api', () => ({
  requireAuth: jest.fn().mockResolvedValue({ id: 'user-1' }),
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { authenticated: {} },
  getSupabaseAdmin: jest.fn(() => ({ from: jest.fn(() => cacheQuery) })),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function req(body: unknown) {
  return new NextRequest('https://www.arenafi.org/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/translate', () => {
  const fetchMock = jest.fn()
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = fetchMock as unknown as typeof fetch
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([[['你好', 'hello']]]), {
        headers: { 'content-type': 'application/json' },
      })
    )
    mockUpsert.mockResolvedValue({ error: null })
  })

  it('rejects oversized single text with 400 before translating', async () => {
    const res = await POST(req({ text: 'a'.repeat(10_001), targetLang: 'zh' }))
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a batch containing an oversized item with 400', async () => {
    const res = await POST(
      req({
        targetLang: 'zh',
        items: [
          { id: '1', text: 'hello', contentType: 'comment', contentId: 'c1' },
          { id: '2', text: 'a'.repeat(10_001), contentType: 'comment', contentId: 'c2' },
        ],
      })
    )
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unsupported target language', async () => {
    const res = await POST(req({ text: 'hello', targetLang: 'xx' }))
    expect(res.status).toBe(400)
  })

  it('logs (does not swallow) a cache upsert error but still returns the translation', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'permission denied' } })
    const res = await POST(
      req({ text: 'hello world', targetLang: 'zh', contentType: 'comment', contentId: 'c1' })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.translatedText).toBe('你好')
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Translation cache save failed',
      expect.objectContaining({ error: 'permission denied' })
    )
  })
})
