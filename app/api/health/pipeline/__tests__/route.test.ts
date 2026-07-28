const mockVerifyAdminAuth = jest.fn()
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockGetJobStatuses = jest.fn()
const mockGetJobStats = jest.fn()
const mockGetRecentFailures = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockBuildPlatformHealth = jest.fn()
const mockClassifyPlatformHealth = jest.fn()
const mockLoggerWarn = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: (...args: unknown[]) => mockVerifyAdminAuth(...args),
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    getJobStatuses: (...args: unknown[]) => mockGetJobStatuses(...args),
    getJobStats: (...args: unknown[]) => mockGetJobStats(...args),
    getRecentFailures: (...args: unknown[]) => mockGetRecentFailures(...args),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

jest.mock('@/lib/services/platform-health', () => ({
  buildPlatformHealth: (...args: unknown[]) => mockBuildPlatformHealth(...args),
  classifyPlatformHealth: (...args: unknown[]) => mockClassifyPlatformHealth(...args),
}))

jest.mock('@/lib/constants/exchanges', () => ({
  DEAD_BLOCKED_PLATFORMS: [],
  EXCHANGE_CONFIG: { binance: { name: 'Binance' } },
}))

jest.mock('@/lib/utils/logger', () => ({
  getFireAndForgetStats: () => ({}),
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}))

jest.mock('@/lib/ratelimit/TokenBucket', () => ({
  getRateLimitStats: () => ({}),
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
      return { get: (key: string) => this._headers.get(key) || null }
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextRequest: class {}, NextResponse: MockNextResponse }
})

function resolvedPipelineLogQuery(result: { data: unknown[]; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    not: () => chain,
    gt: () => chain,
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (error: unknown) => unknown
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return chain
}

describe('GET /api/health/pipeline', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    mockVerifyAdminAuth.mockResolvedValue(true)
    mockTieredGet.mockResolvedValue({ data: null, layer: null })
    mockTieredSet.mockResolvedValue(undefined)
    mockGetJobStatuses.mockResolvedValue([
      {
        job_name: 'fetch-binance',
        started_at: '2026-07-28T00:00:00.000Z',
        status: 'success',
        records_processed: 10,
        error_message: null,
        health_status: 'healthy',
      },
    ])
    mockGetJobStats.mockResolvedValue([
      {
        job_name: 'fetch-binance',
        total_runs: 10,
        success_count: 10,
        error_count: 0,
        success_rate: 100,
        avg_duration_ms: 100,
        last_run_at: '2026-07-28T00:00:00.000Z',
      },
    ])
    mockGetRecentFailures.mockResolvedValue([])
    mockFrom.mockReturnValue(resolvedPipelineLogQuery({ data: [], error: null }))
    mockRpc.mockResolvedValue({
      data: [{ platform: 'binance', latest: '2026-07-28T00:00:00.000Z' }],
      error: null,
    })
    mockBuildPlatformHealth.mockReturnValue([
      {
        platform: 'binance',
        displayName: 'Binance',
        lastUpdate: '2026-07-28T00:00:00.000Z',
        ageHours: 0,
        currentCount: 10,
        avgCount: 10,
        countRatio: 1,
        status: 'healthy',
      },
    ])
    mockClassifyPlatformHealth.mockReturnValue('healthy')
  })

  it('reports an unavailable authentication authority within its own database budget', async () => {
    jest.useFakeTimers()
    mockVerifyAdminAuth.mockReturnValueOnce(new Promise(() => undefined))

    try {
      const { GET } = await import('../route')
      const responsePromise = GET({} as never)
      await jest.advanceTimersByTimeAsync(5_000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.status).toBe('critical')
      expect(body.authority).toEqual({ status: 'unavailable', unavailable: ['admin_auth'] })
      expect(body.error.code).toBe('PIPELINE_AUTH_TIMEOUT')
      expect(mockTieredGet).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('preserves an authentication authority rejection as a structured 503', async () => {
    mockVerifyAdminAuth.mockRejectedValueOnce(new Error('auth database transport unavailable'))

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.authority).toEqual({ status: 'unavailable', unavailable: ['admin_auth'] })
    expect(body.error).toEqual({
      code: 'PIPELINE_AUTH_UNAVAILABLE',
      message: 'auth database transport unavailable',
    })
    expect(mockTieredGet).not.toHaveBeenCalled()
  })

  it('keeps an explicit invalid credential response as 401', async () => {
    mockVerifyAdminAuth.mockResolvedValueOnce(false)

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(mockTieredGet).not.toHaveBeenCalled()
  })

  it('returns a structured critical 503 before the transport deadline when DB work hangs', async () => {
    jest.useFakeTimers()
    const pending = new Promise(() => undefined)
    mockTieredGet.mockReturnValueOnce(pending)
    mockGetJobStatuses.mockReturnValueOnce(pending)
    mockGetJobStats.mockReturnValueOnce(pending)
    mockGetRecentFailures.mockReturnValueOnce(pending)
    mockFrom.mockReturnValueOnce(resolvedPipelineLogQuery({ data: [], error: null }))
    mockRpc.mockReturnValueOnce(pending)

    try {
      const { GET } = await import('../route')
      const responsePromise = GET({} as never)

      await jest.advanceTimersByTimeAsync(1_500)
      await jest.advanceTimersByTimeAsync(10_000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(response.headers.get('X-Degraded')).toBe('1')
      expect(body.status).toBe('critical')
      expect(body.authority).toEqual({
        status: 'unavailable',
        unavailable: ['pipeline_database'],
      })
      expect(body.error).toEqual({
        code: 'PIPELINE_HEALTH_UNAVAILABLE',
        message: 'active platform freshness authority is unavailable',
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not label an empty database authority result healthy', async () => {
    mockGetJobStatuses.mockResolvedValueOnce([])

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('X-Degraded')).toBe('1')
    expect(body.status).toBe('critical')
    expect(body.authority).toEqual({
      status: 'unavailable',
      unavailable: ['job_statuses'],
    })
    expect(mockTieredSet).not.toHaveBeenCalled()
  })

  it('returns healthy data and caches it only when all authorities are present', async () => {
    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Degraded')).toBe('0')
    expect(body.status).toBe('healthy')
    expect(body.authority).toEqual({ status: 'available', unavailable: [] })
    expect(mockTieredSet).toHaveBeenCalledWith(
      'api:health:pipeline:v7',
      expect.objectContaining({ authority: { status: 'available', unavailable: [] } }),
      'warm',
      ['pipeline-health']
    )
  })
})
