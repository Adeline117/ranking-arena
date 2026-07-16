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
      this.method = init.method ?? 'PATCH'
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
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()
const mockUpdate = jest.fn()
const mockEq = jest.fn()
const mockSelect = jest.fn()
const mockMaybeSingle = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { NextRequest, NextResponse } from 'next/server'
import { PATCH } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const query = {
  update: mockUpdate,
  eq: mockEq,
  select: mockSelect,
  maybeSingle: mockMaybeSingle,
}

function request(body: unknown) {
  return new NextRequest('http://localhost/api/profile/notification-preferences', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/profile/notification-preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue(query)
    mockUpdate.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockMaybeSingle.mockResolvedValue({ data: { id: USER_ID }, error: null })
  })

  it.each([
    'notify_follow',
    'notify_like',
    'notify_comment',
    'notify_mention',
    'notify_message',
    'notify_trader_events',
  ])('updates only the authenticated profile field %s', async (field) => {
    const req = request({ field, value: false })
    const response = await PATCH(req)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(mockGetAuthUser).toHaveBeenCalledWith(req)
    expect(mockGetAuthUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetSupabaseAdmin.mock.invocationCallOrder[0]
    )
    expect(mockUpdate).toHaveBeenCalledWith({ [field]: false })
    expect(mockEq).toHaveBeenCalledWith('id', USER_ID)
    expect(mockSelect).toHaveBeenCalledWith('id')
  })

  it.each(['none', 'daily', 'weekly'])(
    'updates email digest to the allowlisted value %s',
    async (value) => {
      const req = request({ field: 'email_digest', value })
      const response = await PATCH(req)

      expect(response.status).toBe(200)
      expect(mockGetAuthUser).toHaveBeenCalledWith(req)
      expect(mockUpdate).toHaveBeenCalledWith({ email_digest: value })
      expect(mockEq).toHaveBeenCalledWith('id', USER_ID)
    }
  )

  it('does not initialize admin access for an unauthenticated request', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await PATCH(request({ field: 'notify_follow', value: true }))

    expect(response.status).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('returns the rate-limit response before authentication', async () => {
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    mockCheckRateLimit.mockResolvedValue(limited)

    const response = await PATCH(request({ field: 'notify_follow', value: true }))

    expect(response).toBe(limited)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
  })

  it.each([
    [{}, 'empty body'],
    [{ field: 'is_pro', value: true }, 'unapproved field'],
    [{ field: 'notify_follow', value: 'true' }, 'non-boolean value'],
    [{ field: 'email_digest', value: true }, 'non-string digest'],
    [{ field: 'email_digest', value: 'monthly' }, 'unapproved digest'],
    [{ field: 'notify_follow', value: true, userId: USER_ID }, 'unknown field'],
  ])('rejects %s (%s) before initializing admin access', async (body) => {
    const response = await PATCH(request(body))

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('fails closed on a zero-row update or database error', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    expect((await PATCH(request({ field: 'notify_follow', value: true }))).status).toBe(503)

    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX001', message: 'write failed' },
    })
    expect((await PATCH(request({ field: 'notify_follow', value: true }))).status).toBe(503)
  })
})
