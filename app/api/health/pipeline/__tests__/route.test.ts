const mockVerifyAdminAuthResult = jest.fn()
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
const observedSupabaseSignals: AbortSignal[] = []

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuthResult: (...args: unknown[]) => mockVerifyAdminAuthResult(...args),
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
    abortSignal: (signal: AbortSignal) => {
      observedSupabaseSignals.push(signal)
      return Promise.resolve(result)
    },
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (error: unknown) => unknown
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return chain
}

function pendingPipelineLogQuery(pending: Promise<never>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    not: () => chain,
    gt: () => chain,
    abortSignal: (signal: AbortSignal) => {
      observedSupabaseSignals.push(signal)
      return pending
    },
  }
  return chain
}

function abortableQuery<T>(result: Promise<T> | T) {
  return {
    abortSignal(signal: AbortSignal) {
      observedSupabaseSignals.push(signal)
      return Promise.resolve(result)
    },
  }
}

describe('GET /api/health/pipeline', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    observedSupabaseSignals.length = 0
    mockVerifyAdminAuthResult.mockResolvedValue({ status: 'authorized' })
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
    mockRpc.mockReturnValue(
      abortableQuery({
        data: [{ platform: 'binance', latest: '2026-07-28T00:00:00.000Z' }],
        error: null,
      })
    )
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
    mockVerifyAdminAuthResult.mockReturnValueOnce(new Promise(() => undefined))

    try {
      const { GET } = await import('../route')
      const startedAt = Date.now()
      const responsePromise = GET({} as never)
      await jest.advanceTimersByTimeAsync(3_000)
      const response = await responsePromise
      const body = await response.json()

      expect(Date.now() - startedAt).toBeLessThan(9_500)
      expect(response.status).toBe(503)
      expect(body.status).toBe('critical')
      expect(body.authority).toEqual({ status: 'unavailable', unavailable: ['admin_auth'] })
      expect(body.error.code).toBe('PIPELINE_AUTH_TIMEOUT')
      expect(mockTieredGet).not.toHaveBeenCalled()
      const authSignal = mockVerifyAdminAuthResult.mock.calls[0][1].signal as AbortSignal
      expect(authSignal.aborted).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('preserves an authentication authority rejection as a structured 503', async () => {
    mockVerifyAdminAuthResult.mockRejectedValueOnce(
      new Error('auth database transport unavailable')
    )

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.authority).toEqual({ status: 'unavailable', unavailable: ['admin_auth'] })
    expect(body.error).toEqual({
      code: 'PIPELINE_AUTH_UNAVAILABLE',
      message: 'Pipeline health authentication authority is unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('database transport')
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[health/pipeline] Admin authentication authority failed',
      { error: 'auth database transport unavailable' }
    )
    expect(mockTieredGet).not.toHaveBeenCalled()
  })

  it('preserves a real unavailable authentication verdict as a structured 503', async () => {
    mockVerifyAdminAuthResult.mockResolvedValueOnce({
      status: 'unavailable',
      error: new Error('auth database transport unavailable'),
    })

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toEqual({
      code: 'PIPELINE_AUTH_UNAVAILABLE',
      message: 'Pipeline health authentication authority is unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('database transport')
    expect(mockTieredGet).not.toHaveBeenCalled()
  })

  it('keeps an explicit invalid credential response as 401', async () => {
    mockVerifyAdminAuthResult.mockResolvedValueOnce({ status: 'invalid' })

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
    expect(mockTieredGet).not.toHaveBeenCalled()
  })

  it('logs dependency failures without returning internal connection details', async () => {
    const internalError = 'postgres://health-reader:super-secret@private-db.internal/postgres'
    mockTieredGet.mockRejectedValueOnce(new Error(internalError))

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toEqual({
      code: 'PIPELINE_HEALTH_UNAVAILABLE',
      message: 'Pipeline health authority is unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(JSON.stringify(body)).not.toContain('private-db.internal')
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[health/pipeline] Unhandled error while computing health snapshot',
      expect.objectContaining({ error: internalError })
    )
  })

  it('fails closed and skips cache writes when recent-failure authority rejects', async () => {
    const internalError = 'permission denied at private-db.internal'
    mockGetRecentFailures.mockRejectedValueOnce(new Error(internalError))

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toEqual({
      code: 'PIPELINE_HEALTH_UNAVAILABLE',
      message: 'Pipeline health authority is unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('private-db.internal')
    expect(mockGetRecentFailures).toHaveBeenCalledWith(10, 120, expect.any(AbortSignal), true)
    expect(mockTieredSet).not.toHaveBeenCalled()
  })

  it('fails closed when recent-failure authority alone exceeds its phase budget', async () => {
    jest.useFakeTimers()
    mockGetRecentFailures.mockReturnValueOnce(new Promise(() => undefined))

    try {
      const { GET } = await import('../route')
      const responsePromise = GET({} as never)

      await jest.advanceTimersByTimeAsync(6_000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.status).toBe('critical')
      expect(body.authority).toEqual({
        status: 'unavailable',
        unavailable: ['recent_failures'],
      })
      expect(mockGetRecentFailures.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
      expect((mockGetRecentFailures.mock.calls[0][2] as AbortSignal).aborted).toBe(true)
      expect(mockTieredSet).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('fails closed and skips cache writes when pipeline log averages reject', async () => {
    mockFrom.mockReturnValueOnce(
      resolvedPipelineLogQuery({
        data: [],
        error: { message: 'permission denied at private-db.internal' },
      })
    )

    const { GET } = await import('../route')
    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error).toEqual({
      code: 'PIPELINE_HEALTH_UNAVAILABLE',
      message: 'Pipeline health authority is unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('private-db.internal')
    expect(mockTieredSet).not.toHaveBeenCalled()
  })

  it('fails closed when pipeline log averages alone exceed their phase budget', async () => {
    jest.useFakeTimers()
    const pending = new Promise<never>(() => undefined)
    mockFrom.mockReturnValueOnce(pendingPipelineLogQuery(pending))

    try {
      const { GET } = await import('../route')
      const responsePromise = GET({} as never)

      await jest.advanceTimersByTimeAsync(6_000)
      const response = await responsePromise
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body.error).toEqual({
        code: 'PIPELINE_HEALTH_UNAVAILABLE',
        message: 'Pipeline health authority is unavailable',
      })
      expect(observedSupabaseSignals).toHaveLength(2)
      expect(observedSupabaseSignals.filter((signal) => signal.aborted)).toHaveLength(1)
      expect(mockTieredSet).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('returns a structured critical 503 before the transport deadline when DB work hangs', async () => {
    jest.useFakeTimers()
    const pending = new Promise(() => undefined)
    mockTieredGet.mockReturnValueOnce(pending)
    mockGetJobStatuses.mockReturnValueOnce(pending)
    mockGetJobStats.mockReturnValueOnce(pending)
    mockGetRecentFailures.mockReturnValueOnce(pending)
    mockFrom.mockReturnValueOnce(resolvedPipelineLogQuery({ data: [], error: null }))
    mockRpc.mockReturnValueOnce(abortableQuery(pending))

    try {
      const { GET } = await import('../route')
      const startedAt = Date.now()
      const responsePromise = GET({} as never)

      await jest.advanceTimersByTimeAsync(1_000)
      await jest.advanceTimersByTimeAsync(7_500)
      const response = await responsePromise
      const body = await response.json()

      expect(Date.now() - startedAt).toBeLessThan(9_500)
      expect(response.status).toBe(503)
      expect(response.headers.get('X-Degraded')).toBe('1')
      expect(body.status).toBe('critical')
      expect(body.authority).toEqual({
        status: 'unavailable',
        unavailable: ['pipeline_database'],
      })
      expect(body.error).toEqual({
        code: 'PIPELINE_HEALTH_UNAVAILABLE',
        message: 'Pipeline health authority is unavailable',
      })
      const pipelineSignals = [
        mockGetJobStatuses.mock.calls[0][0],
        mockGetJobStats.mock.calls[0][0],
        mockGetRecentFailures.mock.calls[0][2],
      ] as AbortSignal[]
      expect(pipelineSignals.every((signal) => signal.aborted)).toBe(true)
      expect(observedSupabaseSignals.some((signal) => signal.aborted)).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('uses the remaining absolute budget after slow JWT auth and cache phases', async () => {
    jest.useFakeTimers()
    const pending = new Promise(() => undefined)
    mockVerifyAdminAuthResult.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 'authorized' }), 2_999))
    )
    mockTieredGet.mockReturnValueOnce(pending)
    mockGetJobStatuses.mockReturnValueOnce(pending)
    mockGetJobStats.mockReturnValueOnce(pending)
    mockGetRecentFailures.mockReturnValueOnce(pending)

    try {
      const { GET } = await import('../route')
      const startedAt = Date.now()
      const responsePromise = GET({} as never)

      await jest.advanceTimersByTimeAsync(2_999)
      await jest.advanceTimersByTimeAsync(1_000)
      await jest.advanceTimersByTimeAsync(5_251)
      const response = await responsePromise
      const body = await response.json()

      expect(Date.now() - startedAt).toBeLessThanOrEqual(9_250)
      expect(15_000 - (Date.now() - startedAt)).toBeGreaterThanOrEqual(5_750)
      expect(response.status).toBe(503)
      expect(body.error.code).toBe('PIPELINE_HEALTH_TIMEOUT')
      const pipelineSignals = [
        mockGetJobStatuses.mock.calls[0][0],
        mockGetJobStats.mock.calls[0][0],
        mockGetRecentFailures.mock.calls[0][2],
      ] as AbortSignal[]
      expect(pipelineSignals.every((signal) => signal.aborted)).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
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
    expect(mockGetJobStatuses.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
    expect(mockGetJobStats.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
    expect(mockGetRecentFailures.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
  })
})
