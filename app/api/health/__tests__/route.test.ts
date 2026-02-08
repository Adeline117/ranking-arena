/**
 * /api/health 路由测试 (轻量版)
 */

const mockJsonFn = jest.fn()
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

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        limit: jest.fn(() => Promise.resolve({ data: [{ id: 1 }], error: null })),
      })),
    })),
  })),
}))

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => ({
    ping: jest.fn(() => Promise.resolve('PONG')),
  })),
}))

describe('GET /api/health', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  })

  it('should return health check response with correct structure', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body).toHaveProperty('status')
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(body).toHaveProperty('timestamp')
    expect(body).toHaveProperty('version')
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
})

describe('HEAD /api/health', () => {
  it('should return 200', async () => {
    const { HEAD } = await import('../route')
    const response = await HEAD()
    expect(response.status).toBe(200)
  })
})
