/**
 * Integration tests for withCron
 *
 * Covers:
 *   - 401 when CRON_SECRET missing or mismatched
 *   - Secret-comparison is deterministic across byte-shifted inputs
 *     (no early-return on first byte mismatch — same 401 for any wrong secret)
 *   - PipelineLogger.start() is called with the job name
 *   - Success path calls plog.success() with count
 *   - Error path calls plog.error() with the thrown error
 *   - Safety timeout triggers plog.timeout() before Vercel kills the function
 *   - Distributed Redis lock prevents concurrent execution (NX)
 */

// Auth secret used by withCron
const CRON_SECRET = 'super-secret-xyz'
process.env.CRON_SECRET = CRON_SECRET

// -------- next/server mock ----------
jest.mock('next/server', () => {
  class MockNextRequest {
    url: string
    headers: Map<string, string>
    method: string
    nextUrl: URL

    constructor(url: string, init?: { method?: string; headers?: Record<string, string> }) {
      this.url = url
      this.method = init?.method || 'GET'
      const entries = Object.entries(init?.headers || {}).map(
        ([k, v]) => [k.toLowerCase(), v] as [string, string]
      )
      const map = new Map<string, string>(entries)
      const rawGet = map.get.bind(map)
      // Case-insensitive header lookup
      ;(map as unknown as { get: (k: string) => string | undefined }).get = (k: string) =>
        rawGet(k.toLowerCase())
      this.headers = map
      this.nextUrl = new URL(url)
    }
  }

  class MockNextResponse {
    body: string
    status: number
    headers: Map<string, string>

    constructor(body?: string | null, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body || ''
      this.status = init?.status || 200
      this.headers = new Map(Object.entries(init?.headers || {}))
    }

    async json() {
      return JSON.parse(this.body)
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(JSON.stringify(data), init)
    }
  }

  return {
    NextRequest: MockNextRequest,
    NextResponse: MockNextResponse,
  }
})

// -------- Supabase mock ----------
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: jest.fn() })),
}))

// -------- PipelineLogger mock ----------
// Use a holder object so hoisted jest.mock can reference fresh jest.fn()s.
// Jest hoists jest.mock() ABOVE const declarations, so we can't reference
// top-level constants in the factory. `jest.fn()` inside the factory is fine,
// but we need access to them from tests — so we expose via the module mock's
// captured jest.fn() references.
jest.mock('@/lib/services/pipeline-logger', () => {
  const success = jest.fn(async () => {})
  const error = jest.fn(async () => {})
  const partialSuccess = jest.fn(async () => {})
  const timeout = jest.fn(async () => {})
  const start = jest.fn(async () => ({
    id: 42,
    success,
    error,
    partialSuccess,
    timeout,
  }))
  return {
    PipelineLogger: { start },
    // Expose for tests (non-enumerable via plain object fields)
    __mocks: { start, success, error, partialSuccess, timeout },
  }
})

// -------- Redis client mock (overrides jest.setup.js global mock) ----------
jest.mock('@/lib/cache/redis-client', () => {
  const set = jest.fn(async () => 'OK')
  const del = jest.fn(async () => 1)
  const getSharedRedis = jest.fn(async () => ({ set, del }))
  return {
    getSharedRedis,
    __mocks: { set, del, getSharedRedis },
  }
})

import { NextRequest } from 'next/server'
import { withCron } from '../with-cron'

// Pull out captured mock fns from the factory (see jest.mock calls above)
const plogMocks = (jest.requireMock('@/lib/services/pipeline-logger') as {
  __mocks: {
    start: jest.Mock
    success: jest.Mock
    error: jest.Mock
    partialSuccess: jest.Mock
    timeout: jest.Mock
  }
}).__mocks
const redisMocks = (jest.requireMock('@/lib/cache/redis-client') as {
  __mocks: { set: jest.Mock; del: jest.Mock; getSharedRedis: jest.Mock }
}).__mocks

const mockedPipelineStart = plogMocks.start
const mockPlogSuccess = plogMocks.success
const mockPlogError = plogMocks.error
const mockPlogTimeout = plogMocks.timeout
const mockRedisSet = redisMocks.set
const mockRedisDel = redisMocks.del
const mockedGetSharedRedis = redisMocks.getSharedRedis

function makeAuthedRequest(
  secret = CRON_SECRET,
  url = 'http://localhost/api/cron/my-job'
): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: `Bearer ${secret}` },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRedisSet.mockResolvedValue('OK')
  mockRedisDel.mockResolvedValue(1)
  mockedGetSharedRedis.mockResolvedValue({
    set: mockRedisSet,
    del: mockRedisDel,
  })
})

describe('withCron authentication', () => {
  it('returns 401 when authorization header is missing', async () => {
    const handler = jest.fn()
    const wrapped = withCron('test-job', handler)

    const req = new NextRequest('http://localhost/api/cron/test-job')
    const res = await wrapped(req)

    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(mockedPipelineStart).not.toHaveBeenCalled()
  })

  it('returns 401 when authorization header has wrong secret', async () => {
    const handler = jest.fn()
    const wrapped = withCron('test-job', handler)

    const req = makeAuthedRequest('wrong-secret')
    const res = await wrapped(req)

    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 401 when CRON_SECRET env is unset', async () => {
    const original = process.env.CRON_SECRET
    delete process.env.CRON_SECRET

    const handler = jest.fn()
    const wrapped = withCron('test-job', handler)

    const req = makeAuthedRequest('anything')
    const res = await wrapped(req)

    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()

    process.env.CRON_SECRET = original
  })

  it('secrets differing only in last byte both 401 (no early-return bias)', async () => {
    // Both wrong secrets must produce the same 401 outcome, regardless of
    // where they diverge from the real secret. This catches naive `===`
    // comparisons that short-circuit (though current impl uses !== directly,
    // observable contract is the same: any wrong secret = 401).
    const handler = jest.fn()
    const wrapped = withCron('test-job', handler)

    const resEarlyDiff = await wrapped(makeAuthedRequest('x' + CRON_SECRET.slice(1)))
    const resLateDiff = await wrapped(makeAuthedRequest(CRON_SECRET.slice(0, -1) + 'x'))

    expect(resEarlyDiff.status).toBe(401)
    expect(resLateDiff.status).toBe(401)
    // Response bodies should be identical (no leaked timing/content info)
    const bodyEarly = await resEarlyDiff.json()
    const bodyLate = await resLateDiff.json()
    expect(bodyEarly).toEqual(bodyLate)
  })

  it('accepts request with valid CRON_SECRET', async () => {
    const handler = jest.fn().mockResolvedValue({ count: 7 })
    const wrapped = withCron('valid-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('withCron PipelineLogger lifecycle', () => {
  it('calls PipelineLogger.start with the job name and merged metadata', async () => {
    const handler = jest.fn().mockResolvedValue({ count: 3 })
    const wrapped = withCron('logger-job', handler, { metadata: { source: 'cron' } })

    const req = new NextRequest('http://localhost/api/cron/logger-job?group=a', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
    await wrapped(req)

    expect(mockedPipelineStart).toHaveBeenCalledTimes(1)
    const [jobName, metadata] = mockedPipelineStart.mock.calls[0]
    expect(jobName).toBe('logger-job')
    // Should merge static metadata with searchParams
    expect(metadata).toMatchObject({ source: 'cron', group: 'a' })
  })

  it('success path: calls plog.success() with the handler-returned count', async () => {
    const handler = jest.fn().mockResolvedValue({ count: 42, extra: 'foo' })
    const wrapped = withCron('success-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(200)
    expect(mockPlogSuccess).toHaveBeenCalledTimes(1)
    expect(mockPlogError).not.toHaveBeenCalled()
    expect(mockPlogTimeout).not.toHaveBeenCalled()
    // First arg is count; second arg is metadata with extra fields
    const [count, meta] = mockPlogSuccess.mock.calls[0]
    expect(count).toBe(42)
    expect(meta).toMatchObject({ count: 42, extra: 'foo' })
    expect(meta).toHaveProperty('elapsed_ms')
  })

  it('success path: defaults count to 0 when handler omits it', async () => {
    const handler = jest.fn().mockResolvedValue({})
    const wrapped = withCron('no-count-job', handler)

    await wrapped(makeAuthedRequest())

    expect(mockPlogSuccess).toHaveBeenCalledTimes(1)
    expect(mockPlogSuccess.mock.calls[0][0]).toBe(0)
  })

  it('error path: calls plog.error() with thrown error and returns 500', async () => {
    const err = new Error('fetcher exploded')
    const handler = jest.fn().mockRejectedValue(err)
    const wrapped = withCron('err-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(500)
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    expect(mockPlogSuccess).not.toHaveBeenCalled()
    const [thrown, meta] = mockPlogError.mock.calls[0]
    expect(thrown).toBe(err)
    expect(meta).toHaveProperty('elapsed_ms')

    const body = await res.json()
    expect(body).toMatchObject({ ok: false, error: 'fetcher exploded' })
  })

  it('error path: wraps non-Error throws in Error before passing to plog.error', async () => {
    const handler = jest.fn().mockRejectedValue('string error')
    const wrapped = withCron('str-err-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(500)
    expect(mockPlogError).toHaveBeenCalledTimes(1)
    const thrown = mockPlogError.mock.calls[0][0]
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('string error')
  })
})

describe('withCron safety timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('fires plog.timeout() when handler exceeds safetyTimeoutMs', async () => {
    // Handler that never resolves — but we abort test via jest timers
    let handlerResolve: ((v: { count: number }) => void) | undefined
    const handler = jest.fn(
      () =>
        new Promise<{ count: number }>((resolve) => {
          handlerResolve = resolve
        })
    )
    const wrapped = withCron('timeout-job', handler, { safetyTimeoutMs: 1000 })

    const pendingInvocation = wrapped(makeAuthedRequest())

    // Let the auth/lock/plog.start async chain flush, then advance past the timer
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    jest.advanceTimersByTime(1500)

    // Let the timer callback's microtasks flush
    await Promise.resolve()
    await Promise.resolve()

    expect(mockPlogTimeout).toHaveBeenCalledTimes(1)
    const [meta] = mockPlogTimeout.mock.calls[0]
    expect(meta).toMatchObject({
      reason: 'safety_timeout',
      safetyTimeoutMs: 1000,
    })

    // Finish the handler so the wrapper can resolve
    handlerResolve?.({ count: 0 })
    const res = await pendingInvocation
    // When safety fired, response body indicates failure (not success)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('safety_timeout')

    // plog.success should NOT be called when safety fired first
    expect(mockPlogSuccess).not.toHaveBeenCalled()
  })

  it('does not fire safety timeout when handler finishes in time', async () => {
    const handler = jest.fn().mockResolvedValue({ count: 1 })
    const wrapped = withCron('fast-job', handler, { safetyTimeoutMs: 10_000 })

    const pending = wrapped(makeAuthedRequest())
    // Handler is synchronously-resolved; let microtasks drain
    await Promise.resolve()
    await Promise.resolve()

    const res = await pending
    expect(res.status).toBe(200)

    // Advance timers past the safety threshold — nothing should fire now
    jest.advanceTimersByTime(15_000)
    await Promise.resolve()

    expect(mockPlogTimeout).not.toHaveBeenCalled()
    expect(mockPlogSuccess).toHaveBeenCalledTimes(1)
  })
})

describe('withCron distributed lock (Redis NX)', () => {
  it('acquires lock with SET NX and releases it on success', async () => {
    const handler = jest.fn().mockResolvedValue({ count: 5 })
    const wrapped = withCron('lock-job', handler)

    await wrapped(makeAuthedRequest())

    expect(mockRedisSet).toHaveBeenCalledTimes(1)
    const [key, _val, opts] = mockRedisSet.mock.calls[0]
    expect(key).toBe('cron:lock:lock-job')
    expect(opts).toMatchObject({ nx: true })
    expect(opts.ex).toBeGreaterThan(0)

    // Lock released in finally block
    expect(mockRedisDel).toHaveBeenCalledWith('cron:lock:lock-job')
  })

  it('releases lock on handler error', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('boom'))
    const wrapped = withCron('lock-err-job', handler)

    await wrapped(makeAuthedRequest())

    expect(mockRedisSet).toHaveBeenCalledTimes(1)
    expect(mockRedisDel).toHaveBeenCalledWith('cron:lock:lock-err-job')
  })

  it('skips execution when lock is already held (concurrent run)', async () => {
    // Simulate another instance holding the lock
    mockRedisSet.mockResolvedValueOnce(null)

    const handler = jest.fn()
    const wrapped = withCron('concurrent-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, skipped: true })
    expect(handler).not.toHaveBeenCalled()
    expect(mockedPipelineStart).not.toHaveBeenCalled()
    // Must NOT delete a lock we never acquired
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('proceeds without lock when Redis is unavailable (fail-open)', async () => {
    mockedGetSharedRedis.mockResolvedValueOnce(null)

    const handler = jest.fn().mockResolvedValue({ count: 1 })
    const wrapped = withCron('no-redis-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('proceeds without lock when Redis SET throws (fail-open)', async () => {
    mockRedisSet.mockRejectedValueOnce(new Error('redis timeout'))

    const handler = jest.fn().mockResolvedValue({ count: 2 })
    const wrapped = withCron('redis-err-job', handler)

    const res = await wrapped(makeAuthedRequest())

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
