/**
 * /api/health 路由测试
 */

// Mock Supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        limit: jest.fn(() => Promise.resolve({ data: [{ id: 1 }], error: null })),
        order: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
        })),
        not: jest.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    })),
    rpc: jest.fn(() => ({
      select: jest.fn(() => Promise.resolve({ data: [], error: null })),
    })),
  })),
}))

// Mock Redis
jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => ({
    ping: jest.fn(() => Promise.resolve('PONG')),
  })),
}))

describe('GET /api/health', () => {
  beforeEach(() => {
    jest.resetModules()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  })

  it('should return health check response with correct structure', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    // Verify top-level fields
    expect(body).toHaveProperty('status')
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status)
    expect(body).toHaveProperty('timestamp')
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('uptime')
    expect(body).toHaveProperty('responseTimeMs')
    expect(body).toHaveProperty('checks')
    expect(body).toHaveProperty('platformFreshness')
  })

  it('should include database, redis, memory, cronStatus checks', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body.checks).toHaveProperty('database')
    expect(body.checks).toHaveProperty('redis')
    expect(body.checks).toHaveProperty('memory')
    expect(body.checks).toHaveProperty('cronStatus')

    // Each check should have a status field
    for (const check of Object.values(body.checks) as Array<{ status: string }>) {
      expect(['pass', 'fail', 'skip']).toContain(check.status)
    }
  })

  it('should include platformFreshness summary', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body.platformFreshness).toHaveProperty('summary')
    expect(body.platformFreshness.summary).toHaveProperty('total')
    expect(body.platformFreshness.summary).toHaveProperty('fresh')
    expect(body.platformFreshness.summary).toHaveProperty('stale')
    expect(body.platformFreshness.summary).toHaveProperty('critical')
    expect(body.platformFreshness).toHaveProperty('platforms')
    expect(Array.isArray(body.platformFreshness.platforms)).toBe(true)
  })

  it('should have proper cache headers', async () => {
    const { GET } = await import('../route')
    const response = await GET()

    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
  })

  it('should return 200 when healthy', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    if (body.status !== 'unhealthy') {
      expect(response.status).toBe(200)
    }
  })

  it('should have valid ISO timestamp', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })

  it('should have non-negative responseTimeMs', async () => {
    const { GET } = await import('../route')
    const response = await GET()
    const body = await response.json()

    expect(body.responseTimeMs).toBeGreaterThanOrEqual(0)
  })
})

describe('HEAD /api/health', () => {
  it('should return 200 with no body', async () => {
    const { HEAD } = await import('../route')
    const response = await HEAD()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
