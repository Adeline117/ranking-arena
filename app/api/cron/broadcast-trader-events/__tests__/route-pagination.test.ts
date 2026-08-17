/** @jest-environment node */

import { NextRequest } from 'next/server'

const mockReleaseLock = jest.fn()
const mockAcquireCronLock = jest.fn()
const mockPipelineStart = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
let mockAuthorized = true

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: () => mockAuthorized,
}))

jest.mock('@/lib/cron/with-cron-lock', () => ({
  acquireCronLock: (...args: unknown[]) => mockAcquireCronLock(...args),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: (...args: unknown[]) => mockPipelineStart(...args),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { GET } from '../route'

describe('broadcast trader events rank-provenance fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthorized = true
    mockAcquireCronLock.mockResolvedValue(mockReleaseLock)
    mockPipelineStart.mockResolvedValue({
      success: mockPipelineSuccess,
      error: mockPipelineError,
    })
  })

  it('does not read data, create notifications, or send pushes without historical provenance', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'skipped',
      reason: 'ranking event provenance unavailable',
      ranking_visibility: 'unknown',
      events: 0,
      notified: 0,
    })
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).toHaveBeenCalledWith(0, {
      reason: 'ranking event provenance unavailable',
      ranking_visibility: 'unknown',
    })
    expect(mockReleaseLock).toHaveBeenCalledTimes(1)
  })

  it('does not start work while another run owns the lock', async () => {
    mockAcquireCronLock.mockResolvedValue(null)

    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    await expect(response.json()).resolves.toEqual({ status: 'skipped', reason: 'already running' })
    expect(mockPipelineStart).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated call before acquiring the lock', async () => {
    mockAuthorized = false

    const response = await GET(new NextRequest('http://localhost/api/cron/broadcast-trader-events'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockAcquireCronLock).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })
})
