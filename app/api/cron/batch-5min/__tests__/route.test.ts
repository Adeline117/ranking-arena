/**
 * @jest-environment node
 */

import type { NextRequest } from 'next/server'

const mockReleaseLock = jest.fn()
const mockAcquireCronLock = jest.fn()
const mockRunWorkerInline = jest.fn()
const mockRefreshHotScoresInline = jest.fn()
const mockRunProCheckoutRecoveryInline = jest.fn()
const mockPlogSuccess = jest.fn()
const mockPlogError = jest.fn()
const mockPipelineStart = jest.fn()

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: jest.fn(() => true),
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}))

jest.mock('@/lib/cron/inline-jobs', () => ({
  runWorkerInline: () => mockRunWorkerInline(),
  refreshHotScoresInline: () => mockRefreshHotScoresInline(),
}))

jest.mock('@/lib/stripe/pro-checkout-reconciler', () => ({
  runProCheckoutRecoveryInline: () => mockRunProCheckoutRecoveryInline(),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: (...args: unknown[]) => mockPipelineStart(...args),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { GET } from '../route'

function request(): NextRequest {
  const { NextRequest } = jest.requireActual<typeof import('next/server')>('next/server')
  return new NextRequest('https://www.arenafi.org/api/cron/batch-5min', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

describe('batch-5min cron lease lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    mockReleaseLock.mockResolvedValue(undefined)
    mockAcquireCronLock.mockResolvedValue({
      status: 'acquired',
      release: mockReleaseLock,
    })
    mockPipelineStart.mockResolvedValue({
      success: mockPlogSuccess,
      error: mockPlogError,
    })
    mockRunWorkerInline.mockResolvedValue({
      name: 'run-worker',
      status: 'success',
      durationMs: 1,
    })
    mockRefreshHotScoresInline.mockResolvedValue({
      name: 'refresh-hot-scores',
      status: 'success',
      durationMs: 1,
    })
    mockRunProCheckoutRecoveryInline.mockResolvedValue({
      name: 'pro-checkout-recovery',
      status: 'success',
      durationMs: 1,
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('awaits owned-lease release after every mutating task settles', async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(mockPlogSuccess).toHaveBeenCalledTimes(1)
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
    expect(mockRunProCheckoutRecoveryInline).toHaveBeenCalledTimes(1)
  })

  it('releases the lease when post-acquisition initialization fails', async () => {
    mockPipelineStart.mockRejectedValueOnce(new Error('pipeline unavailable'))

    await expect(GET(request())).rejects.toThrow('pipeline unavailable')
    expect(mockRunWorkerInline).not.toHaveBeenCalled()
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })

  it('retains the lease until TTL when a timed-out mutating task is still running', async () => {
    mockRunWorkerInline.mockReturnValue(new Promise(() => {}))

    const responsePromise = GET(request())
    await jest.advanceTimersByTimeAsync(90_000)
    const response = await responsePromise

    expect(response.status).toBe(207)
    expect(await response.json()).toMatchObject({
      status: 'partial',
      results: expect.arrayContaining([
        expect.objectContaining({ name: 'run-worker', status: 'error' }),
      ]),
    })
    expect(mockReleaseLock).not.toHaveBeenCalled()
  })
})
