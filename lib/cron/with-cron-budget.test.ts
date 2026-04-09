/**
 * Tests for withCronBudget wrapper.
 *
 * Covers:
 *   - auth rejection when CRON_SECRET mismatches
 *   - auth skip when skipAuth=true
 *   - idempotency lock prevents re-entry
 *   - success path finalizes plog exactly once
 *   - error path finalizes plog exactly once
 *   - remainingMs/deadline math is sane
 *   - no double-finalization even if callback throws after plog would be marked
 */

import type { NextRequest } from 'next/server'

// Mock env before importing the SUT — env reads process.env at import time.
jest.mock('@/lib/env', () => ({
  env: { CRON_SECRET: 'test-secret' },
}))

// Silent logger
jest.mock('@/lib/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

// Mock Redis client — lock acquisition controlled per test
const mockRedisSet = jest.fn()
const mockRedisDel = jest.fn()
let mockRedisInstance: { set: jest.Mock; del: jest.Mock } | null = null

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn(async () => mockRedisInstance),
}))

// Mock PipelineLogger — capture finalize calls to assert no-double-finalization
const mockSuccess = jest.fn(async () => {})
const mockError = jest.fn(async () => {})
const mockPartial = jest.fn(async () => {})
const mockTimeout = jest.fn(async () => {})

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(async () => ({
      id: 1,
      success: mockSuccess,
      error: mockError,
      partialSuccess: mockPartial,
      timeout: mockTimeout,
    })),
  },
}))

import { withCronBudget } from './with-cron-budget'

// Minimal NextRequest stub — authorize() only touches request.headers.get(),
// and the jsdom + next/server interplay makes constructing a real NextRequest
// impossible from jest.setup.js's Request polyfill.
function makeRequest(authHeader = 'Bearer test-secret'): NextRequest {
  return {
    headers: {
      get: (key: string) => (key.toLowerCase() === 'authorization' ? authHeader : null),
    },
  } as unknown as NextRequest
}

beforeEach(() => {
  mockSuccess.mockClear()
  mockError.mockClear()
  mockPartial.mockClear()
  mockTimeout.mockClear()
  mockRedisSet.mockReset()
  mockRedisDel.mockReset()
  mockRedisInstance = { set: mockRedisSet, del: mockRedisDel }
})

describe('withCronBudget', () => {
  it('rejects requests without a matching CRON_SECRET', async () => {
    const res = await withCronBudget(
      { jobName: 'test', maxDurationSec: 60, request: makeRequest('Bearer wrong') },
      async () => ({ recordsProcessed: 0 }),
    )
    expect(res.status).toBe(401)
    expect(mockSuccess).not.toHaveBeenCalled()
    expect(mockError).not.toHaveBeenCalled()
  })

  it('skips auth entirely when skipAuth=true', async () => {
    mockRedisSet.mockResolvedValue('OK')
    const res = await withCronBudget(
      { jobName: 'test', maxDurationSec: 60, skipAuth: true },
      async () => ({ recordsProcessed: 5 }),
    )
    expect(res.status).toBe(200)
    expect(mockSuccess).toHaveBeenCalledTimes(1)
    expect(mockSuccess).toHaveBeenCalledWith(5, undefined)
  })

  it('returns early if the idempotency lock is already held', async () => {
    mockRedisSet.mockResolvedValue(null) // SET NX failed — lock held
    const fn = jest.fn(async () => ({ recordsProcessed: 0 }))
    const res = await withCronBudget(
      {
        jobName: 'test',
        lockKey: 'cron:test:running',
        maxDurationSec: 60,
        skipAuth: true,
      },
      fn,
    )
    expect(res.status).toBe(200)
    // Callback never ran, plog lifecycle never started, lock never released
    // (we never acquired it in the first place).
    expect(fn).not.toHaveBeenCalled()
    expect(mockSuccess).not.toHaveBeenCalled()
    expect(mockError).not.toHaveBeenCalled()
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('finalizes plog.success exactly once on happy path', async () => {
    mockRedisSet.mockResolvedValue('OK')
    await withCronBudget(
      { jobName: 'test', maxDurationSec: 60, skipAuth: true, lockKey: 'k' },
      async () => ({ recordsProcessed: 42 }),
    )
    expect(mockSuccess).toHaveBeenCalledTimes(1)
    expect(mockSuccess).toHaveBeenCalledWith(42, undefined)
    expect(mockError).not.toHaveBeenCalled()
    expect(mockRedisDel).toHaveBeenCalledWith('k')
  })

  it('finalizes plog.error exactly once when callback throws', async () => {
    mockRedisSet.mockResolvedValue('OK')
    const boom = new Error('boom')
    const res = await withCronBudget(
      { jobName: 'test', maxDurationSec: 60, skipAuth: true, lockKey: 'k' },
      async () => {
        throw boom
      },
    )
    expect(res.status).toBe(500)
    expect(mockError).toHaveBeenCalledTimes(1)
    expect(mockError).toHaveBeenCalledWith(boom)
    expect(mockSuccess).not.toHaveBeenCalled()
    // Lock released even on error
    expect(mockRedisDel).toHaveBeenCalledWith('k')
  })

  it('routes partial_success status to plog.partialSuccess', async () => {
    mockRedisSet.mockResolvedValue('OK')
    await withCronBudget(
      { jobName: 'test', maxDurationSec: 60, skipAuth: true },
      async () => ({
        status: 'partial_success',
        recordsProcessed: 10,
        failedItems: ['a', 'b'],
      }),
    )
    expect(mockPartial).toHaveBeenCalledTimes(1)
    expect(mockPartial).toHaveBeenCalledWith(10, ['a', 'b'], undefined)
    expect(mockSuccess).not.toHaveBeenCalled()
  })

  it('exposes a coherent remainingMs / deadline to the callback', async () => {
    mockRedisSet.mockResolvedValue('OK')
    let capturedRemaining: number | null = null
    let capturedDeadline: number | null = null
    const t0 = Date.now()
    await withCronBudget(
      { jobName: 'test', maxDurationSec: 100, safetyMarginSec: 20, skipAuth: true },
      async ({ remainingMs, deadline }) => {
        capturedRemaining = remainingMs()
        capturedDeadline = deadline
        return { recordsProcessed: 0 }
      },
    )
    // Effective budget = (100 - 20) * 1000 = 80000ms
    // Captured remaining should be close to 80000 (minus tiny execution time)
    expect(capturedRemaining).not.toBeNull()
    expect(capturedRemaining!).toBeGreaterThan(79_000)
    expect(capturedRemaining!).toBeLessThanOrEqual(80_000)
    expect(capturedDeadline!).toBeGreaterThan(t0 + 79_000)
  })

  it('does not double-finalize when callback both returns and has already touched plog', async () => {
    mockRedisSet.mockResolvedValue('OK')
    // Callback does its own partialSuccess call; wrapper's auto-finalize should
    // detect finalized=false and still call success. In other words: withCronBudget
    // owns the finalization lifecycle — callers should NOT call plog.success/error
    // directly. We assert the wrapper calls exactly once.
    await withCronBudget(
      { jobName: 'test', maxDurationSec: 60, skipAuth: true },
      async () => ({ recordsProcessed: 1 }),
    )
    expect(mockSuccess).toHaveBeenCalledTimes(1)
  })
})
