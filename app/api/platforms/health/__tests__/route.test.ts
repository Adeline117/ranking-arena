/** @jest-environment node */

const mockFrom = jest.fn()
const mockGetOrSetWithLock = jest.fn()
const mockLoggerWarn = jest.fn()
const mockSupabase = { from: (...args: unknown[]) => mockFrom(...args) }

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})
jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: (context: { supabase: typeof mockSupabase }) => Promise<unknown>) => async () =>
      handler({ supabase: mockSupabase }),
}))
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))
jest.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}))

import { GET } from '../route'

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult) {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'order', 'limit']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.abortSignal = jest.fn(() => builder)
  builder.then = jest.fn(
    (resolve: (result: QueryResult) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
  )
  return builder
}

function invoke() {
  return GET({} as never)
}

describe('GET /api/platforms/health authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    mockGetOrSetWithLock.mockImplementation((_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
  })

  it('publishes only successful source rows and freshness under a bounded cache lane', async () => {
    const health = query({
      data: [
        {
          platform: 'binance_futures',
          status: 'healthy',
          last_success_at: '2026-08-03T17:58:00Z',
          error_count: 0,
        },
      ],
      error: null,
    })
    const logs = query({
      data: [{ job_name: 'fetch-binance_futures', ended_at: '2026-08-03T17:59:00Z' }],
      error: null,
    })
    mockFrom.mockReturnValueOnce(health).mockReturnValueOnce(logs)

    const response = await invoke()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      platforms: [
        {
          platform: 'binance_futures',
          status: 'healthy',
          last_success_at: '2026-08-03T17:58:00Z',
          error_count: 0,
        },
      ],
      freshness: { binance_futures: '2026-08-03T17:59:00Z' },
    })
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'api:platforms:health:v2',
      expect.any(Function),
      expect.objectContaining({ maxWaitMs: 1_500, ttl: 30 })
    )
    expect(health.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(logs.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=30, stale-while-revalidate=60'
    )
  })

  it('fails closed when either primary query fails instead of returning empty 200 data', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: null, error: new Error('database unavailable') }))
      .mockReturnValueOnce(query({ data: [], error: null }))

    const response = await invoke()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Platform health unavailable',
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('fails closed when the empty-log freshness fallback cannot be read', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: [], error: null }))
      .mockReturnValueOnce(query({ data: [], error: null }))
      .mockReturnValueOnce(query({ data: null, error: new Error('fallback unavailable') }))

    const response = await invoke()

    expect(response.status).toBe(503)
    expect(mockFrom).toHaveBeenCalledTimes(3)
  })

  it('physically returns 503 at the route deadline when the cache layer ignores cancellation', async () => {
    jest.useFakeTimers()
    mockGetOrSetWithLock.mockReturnValue(new Promise(() => undefined))

    const request = invoke()
    await jest.advanceTimersByTimeAsync(6_000)
    const response = await request

    expect(response.status).toBe(503)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[platforms/health] Public health authority unavailable',
      expect.objectContaining({
        error: expect.stringContaining('Platform health deadline exceeded'),
      })
    )
  })
})
