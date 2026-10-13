/** @jest-environment node */

import { NextRequest } from 'next/server'

const mockPipelineStart = jest.fn()
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
let mockAuthorized = true

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: () => mockAuthorized,
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

import { POST } from '../route'

describe('ranking-change notification provenance fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthorized = true
    mockPipelineStart.mockResolvedValue({
      success: mockPipelineSuccess,
      error: mockPipelineError,
    })
  })

  it('creates no ranking notifications when historical provenance is unknown', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/notifications/ranking-changes', { method: 'POST' })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 'skipped',
      reason: 'ranking event provenance unavailable',
      ranking_visibility: 'unknown',
      notifications: 0,
    })
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).toHaveBeenCalledWith(0, {
      reason: 'ranking event provenance unavailable',
      ranking_visibility: 'unknown',
    })
  })

  it('rejects an unauthenticated call without starting the pipeline', async () => {
    mockAuthorized = false

    const response = await POST(
      new NextRequest('http://localhost/api/notifications/ranking-changes', { method: 'POST' })
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mockPipelineStart).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })
})
