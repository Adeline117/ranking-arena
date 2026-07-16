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
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()
const mockUpdate = jest.fn()
const mockEq = jest.fn()
const mockIs = jest.fn()
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
import { RateLimitPresets } from '@/lib/utils/rate-limit'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

const query = {
  update: mockUpdate,
  eq: mockEq,
  is: mockIs,
  select: mockSelect,
  maybeSingle: mockMaybeSingle,
}

function request(body: unknown) {
  return new NextRequest('http://localhost/api/profile/attribution', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/profile/attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue(query)
    mockUpdate.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockIs.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockMaybeSingle.mockResolvedValue({ data: { id: USER_ID }, error: null })
  })

  it('authenticates before initializing admin and binds the update to the current user', async () => {
    const req = request({
      utmSource: '  search  ',
      utmMedium: ' paid ',
      utmCampaign: ' launch ',
    })

    const response = await POST(req)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(mockCheckRateLimit).toHaveBeenCalledWith(req, RateLimitPresets.write)
    expect(mockGetAuthUser).toHaveBeenCalledWith(req)
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1)
    expect(mockGetAuthUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetSupabaseAdmin.mock.invocationCallOrder[0]
    )
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockUpdate).toHaveBeenCalledWith({
      utm_source: 'search',
      utm_medium: 'paid',
      utm_campaign: 'launch',
    })
    expect(mockEq).toHaveBeenCalledWith('id', USER_ID)
    expect(mockEq).not.toHaveBeenCalledWith('id', OTHER_USER_ID)
    expect(mockIs.mock.calls).toEqual([
      ['utm_source', null],
      ['utm_medium', null],
      ['utm_campaign', null],
    ])
    expect(mockSelect).toHaveBeenCalledWith('id')
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)
  })

  it('writes only fields supplied by the caller and never echoes attribution values', async () => {
    const response = await POST(request({ utmCampaign: 'retention' }))
    const body = await response.json()

    expect(mockUpdate).toHaveBeenCalledWith({ utm_campaign: 'retention' })
    expect(body).toEqual({ success: true })
    expect(JSON.stringify(body)).not.toContain('retention')
  })

  it('does not initialize the admin client for an unauthenticated request', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request({ utmSource: 'search' }))

    expect(response.status).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns the write-rate-limit response before authentication or admin access', async () => {
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    mockCheckRateLimit.mockResolvedValue(limited)

    const response = await POST(request({ utmSource: 'search' }))

    expect(response).toBe(limited)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it.each([
    [{}, 'empty object'],
    [{ utmSource: '   ' }, 'whitespace-only value'],
    [{ utmSource: 'search', unknown: 'field' }, 'unknown field'],
    [{ utmSource: 'search', userId: OTHER_USER_ID }, 'caller-selected user id'],
    [{ utmSource: 'search\n' }, 'control character after a valid value'],
    [{ utmMedium: `paid\u007fmedia` }, 'DEL control character'],
    [{ utmCampaign: 'x'.repeat(201) }, 'value longer than 200 characters'],
    [{ utmSource: null }, 'null value'],
  ])('rejects %s (%s) without initializing admin', async (body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON without initializing admin', async () => {
    const req = new NextRequest('http://localhost/api/profile/attribution', {
      method: 'POST',
      body: '{not-json',
    })

    const response = await POST(req)

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('fails closed with 503 when the authenticated profile row is missing', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    const response = await POST(request({ utmSource: 'search' }))

    expect(response.status).toBe(503)
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('fails closed with 503 on a database error', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { code: 'XX001', message: 'write failed' },
    })

    const response = await POST(request({ utmSource: 'search' }))

    expect(response.status).toBe(503)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('returns an idempotent response when the tuple was already attributed', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({
      data: {
        id: USER_ID,
        utm_source: 'first-touch',
        utm_medium: null,
        utm_campaign: null,
      },
      error: null,
    })

    const response = await POST(request({ utmSource: 'later-touch' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, status: 'already_attributed' })
    expect(mockSelect).toHaveBeenNthCalledWith(1, 'id')
    expect(mockSelect).toHaveBeenNthCalledWith(2, 'id, utm_source, utm_medium, utm_campaign')
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the zero-row state lookup errors', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({
      data: null,
      error: { code: 'XX002', message: 'read failed' },
    })

    const response = await POST(request({ utmSource: 'search' }))

    expect(response.status).toBe(503)
  })

  it('fails closed when a zero-row update still reads an unattributed tuple', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({
      data: {
        id: USER_ID,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
      },
      error: null,
    })

    const response = await POST(request({ utmSource: 'search' }))

    expect(response.status).toBe(503)
  })

  it('resolves concurrent first-touch requests as one write and one already-attributed result', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: { id: USER_ID }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          id: USER_ID,
          utm_source: 'winner',
          utm_medium: null,
          utm_campaign: null,
        },
        error: null,
      })

    const [firstResponse, secondResponse] = await Promise.all([
      POST(request({ utmSource: 'winner' })),
      POST(request({ utmSource: 'loser' })),
    ])

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(await firstResponse.json()).toEqual({ success: true })
    expect(await secondResponse.json()).toEqual({
      success: true,
      status: 'already_attributed',
    })
    expect(mockUpdate).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['rate limiter', mockCheckRateLimit],
    ['authentication', mockGetAuthUser],
    ['admin initialization', mockGetSupabaseAdmin],
  ])('fails closed with 503 when %s throws', async (_label, dependency) => {
    if (dependency === mockGetSupabaseAdmin) {
      dependency.mockImplementationOnce(() => {
        throw new Error('unavailable')
      })
    } else {
      dependency.mockRejectedValueOnce(new Error('unavailable'))
    }

    const response = await POST(request({ utmSource: 'search' }))

    expect(response.status).toBe(503)
  })
})
