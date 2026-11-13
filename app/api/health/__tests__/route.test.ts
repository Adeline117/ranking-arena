/**
 * /api/health 路由测试 (轻量版)
 */

const mockJsonFn = jest.fn()
const mockBuildFreshnessAuthoritySnapshot = jest.fn()
const mockLoggerWarn = jest.fn()
const mockFrom = jest.fn()
const mockRedisPing = jest.fn()
const mockGetSharedRedis = jest.fn()
const observedSupabaseSignals: AbortSignal[] = []

function abortableResult<T>(result: T | Promise<T>) {
  return {
    abortSignal(signal: AbortSignal) {
      observedSupabaseSignals.push(signal)
      return Promise.resolve(result)
    },
  }
}

function freshnessSnapshot(
  report: Record<string, unknown>,
  overrides: Partial<{
    coverage: { expectedSourceBoards: number; visibleSourceBoards: number }
    latestSuccessfulPublication: { season: '90D'; publishedAt: string } | null
  }> = {}
) {
  return {
    report,
    coverage: { expectedSourceBoards: 32, visibleSourceBoards: 32 },
    latestSuccessfulPublication: {
      season: '90D' as const,
      publishedAt: '2026-07-21T20:00:00.000Z',
    },
    ...overrides,
  }
}

function installFetchMock(implementation?: jest.Mock) {
  const originalFetch = globalThis.fetch
  const fetchMock = implementation || jest.fn()
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  })
  return {
    fetchMock,
    restore() {
      if (originalFetch) {
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          writable: true,
          value: originalFetch,
        })
      } else {
        delete (globalThis as { fetch?: typeof fetch }).fetch
      }
    },
  }
}

jest.mock('@/lib/rankings/build-freshness-report', () => ({
  buildFreshnessAuthoritySnapshot: (...args: unknown[]) =>
    mockBuildFreshnessAuthoritySnapshot(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    _headers: Map<string, string>

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this._headers = new Map(Object.entries(init.headers || {}))
    }

    get headers() {
      return {
        get: (key: string) => this._headers.get(key) || null,
        set: (key: string, value: string) => this._headers.set(key, value),
      }
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      mockJsonFn(data, init)
      return new MockNextResponse(data, init)
    }
  }

  return {
    NextResponse: MockNextResponse,
    NextRequest: class {},
  }
})

describe('GET /api/health', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    observedSupabaseSignals.length = 0
    mockBuildFreshnessAuthoritySnapshot.mockResolvedValue(
      freshnessSnapshot({
        ok: true,
        checked_at: '2026-07-21T20:00:00.000Z',
        summary: { total: 32, fresh: 32, stale: 0, critical: 0, unknown: 0 },
        thresholds: { stale_hours: 8, critical_hours: 24 },
        platforms: [],
      })
    )
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'trader_sources') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          limit: () => abortableResult(Promise.resolve({ data: [{ id: 1 }], error: null })),
        }),
      }
    })
    mockRedisPing.mockResolvedValue('PONG')
    mockGetSharedRedis.mockResolvedValue({ ping: mockRedisPing })
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    delete process.env.VERCEL_GIT_COMMIT_SHA
    delete process.env.VPS_SCRAPER_SG
    delete process.env.VPS_PROXY_SG
    delete process.env.VPS_PROXY_KEY
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    process.env.ARENA_RELEASE_SHA = 'release-sha-for-test'
  })

  it('should return health check response with correct structure', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body).toHaveProperty('status')
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(body).toHaveProperty('timestamp')
    expect(body).toHaveProperty('version')
    expect(body.commit).toBe('release-sha-for-test')
    expect(body).toHaveProperty('uptime')
    expect(body).toHaveProperty('responseTimeMs')
    expect(body).toHaveProperty('checks')
  })

  it('should include database and redis checks', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body.checks).toHaveProperty('database')
    expect(body.checks).toHaveProperty('redis')

    for (const check of Object.values(body.checks) as Array<{ status: string }>) {
      expect(['pass', 'fail', 'skip']).toContain(check.status)
    }
  })

  it('exposes bounded ranking coverage, freshness, and publication evidence', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body.checks.freshness.details).toMatchObject({
      sourceSummary: { total: 32, fresh: 32, stale: 0, critical: 0, unknown: 0 },
      coverage: { expectedSourceBoards: 32, visibleSourceBoards: 32 },
      thresholds: { staleHours: 8, criticalHours: 24 },
      publicationSeason: '90D',
      latestSuccessfulPublicationAt: '2026-07-21T20:00:00.000Z',
      sources: [],
    })
  })

  it('should set no-cache headers', async () => {
    const { GET } = await import('../route')
    const response = await GET()

    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
  })

  it('should have valid ISO timestamp', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(() => new Date(body.timestamp)).not.toThrow()
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })

  it('should have non-negative uptime and responseTimeMs', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(body.responseTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('should include _detail link', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body._detail).toBe('/api/health/detailed')
  })

  it('degrades when any expected source authority is stale, critical, or unknown', async () => {
    mockBuildFreshnessAuthoritySnapshot.mockResolvedValueOnce(
      freshnessSnapshot({
        ok: false,
        checked_at: '2026-07-21T20:00:00.000Z',
        summary: { total: 32, fresh: 15, stale: 1, critical: 15, unknown: 1 },
        thresholds: { stale_hours: 8, critical_hours: 24 },
        platforms: [],
      })
    )

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.stale).toBe(true)
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message: '15/32 sources fresh; 1 stale; 15 critical; 1 unknown',
    })
  })

  it('fails closed when source freshness is healthy but board coverage is incomplete', async () => {
    mockBuildFreshnessAuthoritySnapshot.mockResolvedValueOnce(
      freshnessSnapshot(
        {
          ok: true,
          checked_at: '2026-07-21T20:00:00.000Z',
          summary: { total: 32, fresh: 32, stale: 0, critical: 0, unknown: 0 },
          thresholds: { stale_hours: 8, critical_hours: 24 },
          platforms: [],
        },
        { coverage: { expectedSourceBoards: 32, visibleSourceBoards: 31 } }
      )
    )

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message: '32/32 sources fresh; 0 stale; 0 critical; 0 unknown; 31/32 source boards visible',
    })
  })

  it('fails closed when no expected source-board authority is available', async () => {
    mockBuildFreshnessAuthoritySnapshot.mockResolvedValueOnce(
      freshnessSnapshot(
        {
          ok: true,
          checked_at: '2026-07-21T20:00:00.000Z',
          summary: { total: 0, fresh: 0, stale: 0, critical: 0, unknown: 0 },
          thresholds: { stale_hours: 8, critical_hours: 24 },
          platforms: [],
        },
        { coverage: { expectedSourceBoards: 0, visibleSourceBoards: 0 } }
      )
    )

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message:
        '0/0 sources fresh; 0 stale; 0 critical; 0 unknown; Source-board coverage authority unavailable',
    })
  })

  it('fails closed when source freshness and coverage are healthy but 90D proof is missing', async () => {
    mockBuildFreshnessAuthoritySnapshot.mockResolvedValueOnce(
      freshnessSnapshot(
        {
          ok: true,
          checked_at: '2026-07-21T20:00:00.000Z',
          summary: { total: 32, fresh: 32, stale: 0, critical: 0, unknown: 0 },
          thresholds: { stale_hours: 8, critical_hours: 24 },
          platforms: [],
        },
        { latestSuccessfulPublication: null }
      )
    )

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message:
        '32/32 sources fresh; 0 stale; 0 critical; 0 unknown; 90D publication proof unavailable',
    })
  })

  it('fails closed without exposing authority errors', async () => {
    mockBuildFreshnessAuthoritySnapshot.mockRejectedValueOnce(
      new Error('postgres://service-role:secret@private-host')
    )

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('degraded')
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message: 'Freshness authority unavailable',
    })
    expect(body.checks.freshness.details).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('private-host')
  })

  it('clears health timers after a fast success', async () => {
    jest.useFakeTimers()

    try {
      const { GET } = await import('../route')
      const response = await GET()
      expect(response.status).toBe(200)
      expect(jest.getTimerCount()).toBe(0)

      await jest.advanceTimersByTimeAsync(15_000)
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('clears health timers after a fast authority rejection', async () => {
    jest.useFakeTimers()
    mockBuildFreshnessAuthoritySnapshot.mockRejectedValueOnce(new Error('authority unavailable'))

    try {
      const { GET } = await import('../route')
      const response = await GET()
      expect(response.status).toBe(503)
      expect(jest.getTimerCount()).toBe(0)

      await jest.advanceTimersByTimeAsync(15_000)
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('fails closed when the complete authority exceeds its health budget', async () => {
    jest.useFakeTimers()
    mockBuildFreshnessAuthoritySnapshot.mockReturnValueOnce(new Promise(() => undefined))

    try {
      const { GET } = await import('../route')
      const responsePromise = GET()
      await jest.advanceTimersByTimeAsync(8_000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.checks.freshness).toMatchObject({
        status: 'fail',
        message: 'Freshness authority timed out',
      })
      expect((mockBuildFreshnessAuthoritySnapshot.mock.calls[0][0] as AbortSignal).aborted).toBe(
        true
      )
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('returns unhealthy within the core budget without probing configured VPS endpoints when DB hangs', async () => {
    jest.useFakeTimers()
    process.env.VPS_SCRAPER_SG = 'https://vps.example:3457'
    process.env.VPS_PROXY_KEY = 'vps-key'
    const { fetchMock, restore } = installFetchMock()
    mockFrom.mockImplementationOnce(() => ({
      select: () => ({
        limit: () => abortableResult(new Promise(() => undefined)),
      }),
    }))

    try {
      const { GET } = await import('../route')
      const responsePromise = GET()
      await jest.advanceTimersByTimeAsync(8_000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.status).toBe('unhealthy')
      expect(body.responseTimeMs).toBeLessThanOrEqual(8_000)
      expect(body.checks.database).toMatchObject({
        status: 'fail',
        message: 'DB check timed out (8s)',
      })
      expect(body.checks).not.toHaveProperty('vps')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(observedSupabaseSignals.some((signal) => signal.aborted)).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      restore()
      jest.useRealTimers()
    }
  })

  it('preserves an explicit database failure as unhealthy', async () => {
    const internalError = 'postgres://health-reader:super-secret@private-db.internal/postgres'
    mockFrom.mockImplementationOnce(() => ({
      select: () => ({
        limit: () =>
          abortableResult(Promise.resolve({ data: null, error: { message: internalError } })),
      }),
    }))

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('unhealthy')
    expect(body.checks.database).toMatchObject({
      status: 'fail',
      message: 'Database unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(JSON.stringify(body)).not.toContain('private-db.internal')
    expect(mockLoggerWarn).toHaveBeenCalledWith('[health] Database dependency failed', {
      error: internalError,
    })
  })

  it('distinguishes an unconfigured Redis from a configured unavailable Redis', async () => {
    mockGetSharedRedis.mockResolvedValue(null)

    const { GET } = await import('../route')
    const unconfiguredResponse = await GET()
    const unconfiguredBody = await unconfiguredResponse.json()

    expect(unconfiguredResponse.status).toBe(200)
    expect(unconfiguredBody.checks.redis).toMatchObject({
      status: 'skip',
      message: 'Not configured',
    })

    process.env.UPSTASH_REDIS_REST_URL = 'https://configured-redis.example'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'configured-token'
    const unavailableResponse = await GET()
    const unavailableBody = await unavailableResponse.json()

    expect(unavailableResponse.status).toBe(202)
    expect(unavailableBody.status).toBe('degraded')
    expect(unavailableBody.checks.redis).toMatchObject({
      status: 'fail',
      message: 'Redis unavailable',
    })
  })

  it('does not expose Redis SDK connection details', async () => {
    const internalError = 'https://default:upstash-secret@redis.internal'
    mockGetSharedRedis.mockRejectedValueOnce(new Error(internalError))

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body.checks.redis).toMatchObject({
      status: 'fail',
      message: 'Redis unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('upstash-secret')
    expect(JSON.stringify(body)).not.toContain('redis.internal')
    expect(mockLoggerWarn).toHaveBeenCalledWith('[health] Redis dependency threw', {
      error: internalError,
    })
  })

  it('does not probe configured VPS endpoints or read their pipeline heartbeat', async () => {
    process.env.VPS_SCRAPER_SG = 'https://vps.example:3457'
    process.env.VPS_PROXY_KEY = 'vps-key'
    const fetchMock = jest.fn()
    const { restore } = installFetchMock(fetchMock)

    try {
      const { GET } = await import('../route')
      const response = await GET()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.checks).not.toHaveProperty('vps')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(mockFrom).toHaveBeenCalledWith('trader_sources')
      expect(mockFrom).not.toHaveBeenCalledWith('pipeline_logs')
    } finally {
      restore()
    }
  })

  it('bounds the core worst path below the 15s caller budget without VPS work', async () => {
    jest.useFakeTimers()
    process.env.VPS_SCRAPER_SG = 'https://vps.example:3457'
    process.env.VPS_PROXY_KEY = 'vps-key'
    const fetchMock = jest.fn()
    const { restore } = installFetchMock(fetchMock)
    const delayed = <T>(value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), 7_999))
    mockFrom.mockImplementationOnce(() => ({
      select: () => ({
        limit: () => abortableResult(delayed({ data: [{ id: 1 }], error: null })),
      }),
    }))
    mockGetSharedRedis.mockImplementationOnce(() =>
      delayed({ ping: jest.fn().mockResolvedValue('PONG') })
    )
    mockBuildFreshnessAuthoritySnapshot.mockImplementationOnce(() =>
      delayed(
        freshnessSnapshot({
          ok: true,
          checked_at: '2026-07-28T00:00:00.000Z',
          summary: { total: 32, fresh: 32, stale: 0, critical: 0, unknown: 0 },
          thresholds: { stale_hours: 8, critical_hours: 24 },
          platforms: [],
        })
      )
    )

    try {
      const { GET } = await import('../route')
      const startedAt = Date.now()
      const responsePromise = GET()

      await jest.advanceTimersByTimeAsync(7_999)
      await jest.advanceTimersByTimeAsync(1_251)
      const response = await responsePromise
      const body = await response.json()

      expect(Date.now() - startedAt).toBeLessThanOrEqual(9_250)
      expect(15_000 - (Date.now() - startedAt)).toBeGreaterThanOrEqual(5_750)
      expect(response.status).toBe(200)
      expect(body.checks).not.toHaveProperty('vps')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      restore()
      jest.useRealTimers()
    }
  })

  it('does not use a global newest snapshot as its freshness authority', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const route = readFileSync(join(process.cwd(), 'app/api/health/route.ts'), 'utf8')

    expect(route).not.toContain('arena_latest_snapshot_at')
    expect(route).toContain("from '@/lib/rankings/build-freshness-report'")
    expect(route).not.toMatch(/\bVPS_(?:SCRAPER|PROXY)/)
    expect(route).not.toContain('pipeline_logs')
    expect(route).not.toContain('fetch(')
  })
})

describe('HEAD /api/health', () => {
  it('should return 200 when every check passes', async () => {
    const { HEAD } = await import('../route')
    const response = await HEAD()
    expect(response.status).toBe(200)
  })

  it('reflects stale public data as 503, the same verdict as GET', async () => {
    mockBuildFreshnessAuthoritySnapshot.mockRejectedValueOnce(new Error('authority unavailable'))
    const { HEAD } = await import('../route')
    const response = await HEAD()
    expect(response.status).toBe(503)
  })
})
