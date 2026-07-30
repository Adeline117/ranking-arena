jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers = new Headers()

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const KEY_ID = '11111111-1111-4111-8111-111111111111'
let keysResult: { data: Record<string, unknown>[] | null; error: unknown }
let dailyResult: { data: Record<string, unknown>[] | null; error: unknown }
let liveResult: { data: Record<string, unknown>[] | null; error: unknown }
const mockGte = jest.fn(() => ({ order: jest.fn(async () => dailyResult) }))
const mockDailyIn = jest.fn(() => ({ gte: mockGte }))
const mockLiveIn = jest.fn(async () => liveResult)
const mockEq = jest.fn(async () => keysResult)
const mockFrom = jest.fn((table: string) => {
  if (table === 'api_key_usage_daily') {
    return { select: jest.fn(() => ({ in: mockDailyIn })) }
  }
  if (table === 'api_keys') {
    return {
      select: jest.fn((fields: string) =>
        fields.includes('request_count_today') ? { in: mockLiveIn } : { eq: mockEq }
      ),
    }
  }
  throw new Error(`Unexpected table ${table}`)
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({
      user: { id: 'user-123' },
      supabase: { from: mockFrom },
      request,
    }),
}))

import { GET } from '../route'

function request(days: string | null = '30') {
  const params = new URLSearchParams()
  if (days !== null) params.set('days', days)
  return { nextUrl: { searchParams: params } }
}

function key(overrides: Record<string, unknown> = {}) {
  return { id: KEY_ID, user_id: 'user-123', name: 'Primary', ...overrides }
}

function live(overrides: Record<string, unknown> = {}) {
  return { id: KEY_ID, user_id: 'user-123', request_count_today: 5, ...overrides }
}

describe('GET /api/user/api-keys/usage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T12:00:00.000Z'))
    keysResult = { data: [key()], error: null }
    dailyResult = {
      data: [
        { api_key_id: KEY_ID, date: '2026-07-28', request_count: 3 },
        { api_key_id: KEY_ID, date: '2026-07-29', request_count: 2 },
      ],
      error: null,
    }
    liveResult = { data: [live()], error: null }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('returns an exact 30-day window and merges the authoritative live count', async () => {
    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    expect(mockGte).toHaveBeenCalledWith('date', '2026-06-30')
    await expect(response.json()).resolves.toEqual({
      data: {
        keys: [{ id: KEY_ID, name: 'Primary' }],
        daily: [
          { api_key_id: KEY_ID, date: '2026-07-28', request_count: 3 },
          { api_key_id: KEY_ID, date: '2026-07-29', request_count: 5 },
        ],
        totals: { [KEY_ID]: 8 },
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it.each([
    ['key lookup error', 'keys'],
    ['daily lookup error', 'daily'],
    ['live lookup error', 'live'],
  ])('never presents a %s as zero usage', async (_label, source) => {
    if (source === 'keys') keysResult = { data: null, error: { message: 'unavailable' } }
    if (source === 'daily') dailyResult = { data: null, error: { message: 'unavailable' } }
    if (source === 'live') liveResult = { data: null, error: { message: 'unavailable' } }

    const response = await GET(request() as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch API key usage' })
  })

  it.each([
    ['foreign daily key', { api_key_id: '22222222-2222-4222-8222-222222222222' }],
    ['invalid calendar date', { date: '2026-02-30' }],
    ['date outside the window', { date: '2026-06-29' }],
    ['negative request count', { request_count: -1 }],
  ])('withholds malformed history for a %s', async (_label, drift) => {
    dailyResult = {
      data: [{ api_key_id: KEY_ID, date: '2026-07-28', request_count: 3, ...drift }],
      error: null,
    }

    const response = await GET(request() as never)

    expect(response.status).toBe(500)
  })

  it('requires a complete live count for every listed key', async () => {
    liveResult = { data: [], error: null }

    const response = await GET(request() as never)

    expect(response.status).toBe(500)
  })

  it.each(['0', '91', '30days', '01', ''])('rejects invalid days=%s', async (days) => {
    const response = await GET(request(days) as never)

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns a truthful empty result only after a successful empty key read', async () => {
    keysResult = { data: [], error: null }

    const response = await GET(request(null) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: { keys: [], daily: [], totals: {} },
    })
    expect(mockDailyIn).not.toHaveBeenCalled()
    expect(mockLiveIn).not.toHaveBeenCalled()
  })
})
