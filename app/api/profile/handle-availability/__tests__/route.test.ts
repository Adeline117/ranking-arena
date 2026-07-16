jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }
    async json() {
      return this._body
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    method: string
    headers = new Map<string, string>()
    private readonly rawBody: string | undefined
    constructor(url: string, init: { method?: string; body?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.rawBody = init.body
    }
    async json() {
      if (this.rawBody === undefined) throw new Error('missing body')
      return JSON.parse(this.rawBody)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockQueryOne = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/db', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { NextRequest, NextResponse } from 'next/server'
import { RateLimitPresets } from '@/lib/utils/rate-limit'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function request(body: unknown) {
  return new NextRequest('http://localhost/api/profile/handle-availability', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/profile/handle-availability', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockQueryOne.mockResolvedValue({ taken: false })
  })

  it.each(['a*b', 'a%b', 'a_b', 'a\\b'])(
    'checks the literal handle %s without a pattern operator',
    async (handle) => {
      const response = await POST(request({ handle }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ available: true })
      expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), RateLimitPresets.write)
      expect(mockQueryOne).toHaveBeenCalledTimes(1)
      const [sql, params] = mockQueryOne.mock.calls[0]
      expect(sql).toContain('lower(handle) = lower($1)')
      expect(sql.toLowerCase()).not.toMatch(/\blike\b/)
      expect(params).toEqual([handle, USER_ID])
    }
  )

  it('reports a case-insensitive exact match as unavailable', async () => {
    mockQueryOne.mockResolvedValue({ taken: true })

    const response = await POST(request({ handle: 'Alice' }))

    expect(await response.json()).toEqual({ available: false })
  })

  it('authenticates before issuing the privileged database query', async () => {
    await POST(request({ handle: 'alice' }))

    expect(mockGetAuthUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueryOne.mock.invocationCallOrder[0]
    )
  })

  it('does not query the database when unauthenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request({ handle: 'alice' }))

    expect(response.status).toBe(401)
    expect(mockQueryOne).not.toHaveBeenCalled()
  })

  it('returns the rate-limit response before authentication', async () => {
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    mockCheckRateLimit.mockResolvedValue(limited)

    const response = await POST(request({ handle: 'alice' }))

    expect(response).toBe(limited)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockQueryOne).not.toHaveBeenCalled()
  })

  it.each([
    [{}, 'missing handle'],
    [{ handle: '' }, 'empty handle'],
    [{ handle: ' alice' }, 'leading whitespace'],
    [{ handle: 'alice\n' }, 'control character'],
    [{ handle: 'a'.repeat(31) }, 'too long'],
    [{ handle: 'Administrator' }, 'reserved'],
    [{ handle: 'alice', userId: USER_ID }, 'unknown field'],
  ])('rejects %s (%s) before querying the database', async (body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(mockQueryOne).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON', async () => {
    const req = new NextRequest('http://localhost/api/profile/handle-availability', {
      method: 'POST',
      body: '{not-json',
    })

    const response = await POST(req)

    expect(response.status).toBe(400)
    expect(mockQueryOne).not.toHaveBeenCalled()
  })

  it.each([
    [null, 'missing result'],
    [{ taken: 'false' }, 'invalid result'],
  ])('fails closed when the database returns %s (%s)', async (result) => {
    mockQueryOne.mockResolvedValue(result)

    const response = await POST(request({ handle: 'alice' }))

    expect(response.status).toBe(503)
  })

  it('fails closed when authentication or the database throws', async () => {
    mockGetAuthUser.mockRejectedValueOnce(new Error('auth unavailable'))
    expect((await POST(request({ handle: 'alice' }))).status).toBe(503)

    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockQueryOne.mockRejectedValueOnce(new Error('database unavailable'))
    expect((await POST(request({ handle: 'alice' }))).status).toBe(503)
  })
})
