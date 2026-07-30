/**
 * @jest-environment node
 */

const mockRunFullHealthCheck = jest.fn()
const mockPipelineStateSet = jest.fn()
const mockSendRateLimitedAlert = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, {})
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    },
}))

jest.mock('@/lib/harness/health-checks', () => ({
  runFullHealthCheck: (...args: unknown[]) => mockRunFullHealthCheck(...args),
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    set: (...args: unknown[]) => mockPipelineStateSet(...args),
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const healthyReport = {
  overall: 'healthy',
  score: 100,
  checks: [
    {
      name: 'api:Rankings',
      category: 'api',
      status: 'pass',
      latency_ms: 1,
      details: 'ok',
    },
  ],
  checked_at: '2026-07-29T00:00:00.000Z',
  duration_ms: 1,
}

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/health-check-all')
}

describe('GET /api/cron/health-check-all', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRunFullHealthCheck.mockResolvedValue(healthyReport)
    mockPipelineStateSet.mockResolvedValue(undefined)
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: true,
      handled: true,
      rateLimited: false,
      channels: ['telegram'],
    })
  })

  it('propagates one work deadline into probes and persisted dashboard state', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, count: 1, score: 100, overall: 'healthy' })
    expect(timeoutSpy).toHaveBeenCalledWith(35_000)
    expect(mockRunFullHealthCheck).toHaveBeenCalledWith('https://arena.test', {
      signal: expect.any(AbortSignal),
    })
    expect(mockPipelineStateSet).toHaveBeenCalledWith(
      'health:latest',
      expect.objectContaining({ score: 100, overall: 'healthy' }),
      { signal: expect.any(AbortSignal) }
    )
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
    timeoutSpy.mockRestore()
  })

  it('awaits a degraded alert before acknowledging the health check', async () => {
    mockRunFullHealthCheck.mockResolvedValue({
      ...healthyReport,
      overall: 'critical',
      score: 20,
      checks: [{ ...healthyReport.checks[0], status: 'fail', details: 'database down' }],
    })

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(mockSendRateLimitedAlert).toHaveBeenCalledTimes(1)
    expect(mockPipelineStateSet).toHaveBeenCalledTimes(1)
  })

  it('fails the cron when degraded health cannot reach any alert channel', async () => {
    mockRunFullHealthCheck.mockResolvedValue({
      ...healthyReport,
      overall: 'critical',
      score: 20,
      checks: [{ ...healthyReport.checks[0], status: 'fail' }],
    })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: false,
      rateLimited: false,
      channels: [],
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('Health check alert delivery failed')
  })

  it('accepts an intentionally rate-limited duplicate alert', async () => {
    mockRunFullHealthCheck.mockResolvedValue({
      ...healthyReport,
      overall: 'degraded',
      score: 70,
      checks: [{ ...healthyReport.checks[0], status: 'warn' }],
    })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: true,
      rateLimited: true,
      channels: [],
    })

    await expect(GET(request())).resolves.toMatchObject({ status: 200 })
  })

  it('does not persist or acknowledge a report completed after the work deadline', async () => {
    const controller = new AbortController()
    controller.abort(new Error('health deadline'))
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockPipelineStateSet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
    timeoutSpy.mockRestore()
  })
})
