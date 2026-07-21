/**
 * /api/health 路由测试 (轻量版)
 */

const mockJsonFn = jest.fn()
const mockBuildFreshnessReport = jest.fn()
const mockLoggerWarn = jest.fn()
const mockFrom = jest.fn()
const mockRedisPing = jest.fn()
const mockGetSharedRedis = jest.fn()

jest.mock('@/lib/rankings/build-freshness-report', () => ({
  buildFreshnessReport: (...args: unknown[]) => mockBuildFreshnessReport(...args),
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
    mockBuildFreshnessReport.mockResolvedValue({
      ok: true,
      checked_at: '2026-07-21T20:00:00.000Z',
      summary: { total: 32, fresh: 32, stale: 0, critical: 0, unknown: 0 },
      thresholds: { stale_hours: 8, critical_hours: 24 },
      platforms: [],
    })
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'trader_sources') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          limit: () => Promise.resolve({ data: [{ id: 1 }], error: null }),
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
    mockBuildFreshnessReport.mockResolvedValueOnce({
      ok: false,
      checked_at: '2026-07-21T20:00:00.000Z',
      summary: { total: 32, fresh: 15, stale: 1, critical: 15, unknown: 1 },
      thresholds: { stale_hours: 8, critical_hours: 24 },
      platforms: [],
    })

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body.status).toBe('degraded')
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message: '15/32 sources fresh; 1 stale; 15 critical; 1 unknown',
    })
  })

  it('fails closed without exposing authority errors', async () => {
    mockBuildFreshnessReport.mockRejectedValueOnce(
      new Error('postgres://service-role:secret@private-host')
    )

    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body.status).toBe('degraded')
    expect(body.checks.freshness).toMatchObject({
      status: 'fail',
      message: 'Freshness authority unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('private-host')
  })

  it('clears health timers after a fast success', async () => {
    jest.useFakeTimers()

    try {
      const { GET } = await import('../route')
      const response = await GET()
      expect(response.status).toBe(200)

      await jest.advanceTimersByTimeAsync(15_000)
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('clears health timers after a fast authority rejection', async () => {
    jest.useFakeTimers()
    mockBuildFreshnessReport.mockRejectedValueOnce(new Error('authority unavailable'))

    try {
      const { GET } = await import('../route')
      const response = await GET()
      expect(response.status).toBe(202)

      await jest.advanceTimersByTimeAsync(15_000)
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('fails closed when the complete authority exceeds its health budget', async () => {
    jest.useFakeTimers()
    mockBuildFreshnessReport.mockReturnValueOnce(new Promise(() => undefined))

    try {
      const { GET } = await import('../route')
      const responsePromise = GET()
      await jest.advanceTimersByTimeAsync(8000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(202)
      expect(body.checks.freshness).toMatchObject({
        status: 'fail',
        message: 'Freshness authority timed out',
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not use a global newest snapshot as its freshness authority', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const route = readFileSync(join(process.cwd(), 'app/api/health/route.ts'), 'utf8')

    expect(route).not.toContain('arena_latest_snapshot_at')
    expect(route).toContain("from '@/lib/rankings/build-freshness-report'")
  })
})

describe('HEAD /api/health', () => {
  it('should return 200', async () => {
    const { HEAD } = await import('../route')
    const response = await HEAD()
    expect(response.status).toBe(200)
  })
})
