jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Headers()
    constructor(body?: unknown, init: { status?: number } = {}) {
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
  return { NextResponse: MockNextResponse }
})

const mockVerifyCronSecret = jest.fn()
const mockAcquireCronLock = jest.fn()
const mockReleaseLock = jest.fn()
const mockRefreshHotScores = jest.fn()
const mockPipelineStart = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: (...args: unknown[]) => mockVerifyCronSecret(...args),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}))

jest.mock('@/lib/cron/inline-jobs', () => ({
  refreshHotScoresInline: (...args: unknown[]) => mockRefreshHotScores(...args),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: (...args: unknown[]) => mockPipelineStart(...args),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { GET } from '../route'

describe('GET /api/cron/batch-5min', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyCronSecret.mockReturnValue(true)
    mockReleaseLock.mockResolvedValue(undefined)
    mockAcquireCronLock.mockResolvedValue({ status: 'acquired', release: mockReleaseLock })
    mockPipelineStart.mockResolvedValue({
      success: (...args: unknown[]) => mockPipelineSuccess(...args),
      error: (...args: unknown[]) => mockPipelineError(...args),
    })
    mockRefreshHotScores.mockResolvedValue({
      name: 'refresh-hot-scores',
      status: 'success',
      durationMs: 5,
      detail: { method: 'incremental', count: 0 },
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('returns success, clears its deadline, and awaits lock release', async () => {
    jest.useFakeTimers()

    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('success')
    expect(mockRefreshHotScores).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
    await jest.advanceTimersByTimeAsync(90_000)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('aborts a timed-out mutation before releasing the lock and returns non-2xx', async () => {
    jest.useFakeTimers()
    let receivedSignal: AbortSignal | undefined
    mockRefreshHotScores.mockImplementation((signal: AbortSignal) => {
      receivedSignal = signal
      return new Promise(() => undefined)
    })

    const responsePromise = GET({} as never)
    await jest.advanceTimersByTimeAsync(90_000)
    const response = await responsePromise
    const body = await response.json()

    expect(receivedSignal?.aborted).toBe(true)
    expect(response.status).toBe(504)
    expect(body.status).toBe('timeout')
    expect(mockPipelineError).toHaveBeenCalled()
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('returns 500 rather than a successful multi-status for a failed only job', async () => {
    mockRefreshHotScores.mockResolvedValue({
      name: 'refresh-hot-scores',
      status: 'error',
      durationMs: 5,
      error: 'database unavailable',
    })

    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.status).toBe('partial')
    expect(mockPipelineError).toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })

  it('still releases the distributed lock when pipeline logging cannot start', async () => {
    mockPipelineStart.mockRejectedValue(new Error('pipeline logger unavailable'))

    await expect(GET({} as never)).rejects.toThrow('pipeline logger unavailable')
    expect(mockRefreshHotScores).not.toHaveBeenCalled()
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })
})
