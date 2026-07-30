/**
 * @jest-environment node
 */

const mockFreshnessAbort = jest.fn()
const mockQueryBuilder: Record<string, jest.Mock> = {}
mockQueryBuilder.select = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.eq = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.order = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.limit = jest.fn(() => mockQueryBuilder)
mockQueryBuilder.abortSignal = mockFreshnessAbort

const mockFrom = jest.fn(() => mockQueryBuilder)
const mockTriggerSeasonCompute = jest.fn()
const mockSendRateLimitedAlert = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, { supabase: { from: mockFrom } })
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
}))

jest.mock('../recovery-trigger', () => ({
  ...jest.requireActual('../recovery-trigger'),
  triggerSeasonCompute: (...args: unknown[]) => mockTriggerSeasonCompute(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const NOW = Date.parse('2026-07-29T10:00:00.000Z')
const freshRow = [{ computed_at: new Date(NOW - 60_000).toISOString() }]
const staleRow = [{ computed_at: new Date(NOW - 4 * 60 * 60 * 1000).toISOString() }]

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/compute-leaderboard-watchdog')
}

describe('GET /api/cron/compute-leaderboard-watchdog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    mockFreshnessAbort.mockResolvedValue({ data: freshRow, error: null })
    mockTriggerSeasonCompute.mockImplementation(async (_base, _secret, season) => ({
      season,
      triggered: true,
      note: 'HTTP 200 acknowledged',
    }))
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: true,
      handled: true,
      rateLimited: false,
      channels: ['telegram'],
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('checks all three seasons under bounded reads and performs no recovery when fresh', async () => {
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, stale: false })
    expect(mockFreshnessAbort).toHaveBeenCalledTimes(3)
    expect(mockFreshnessAbort).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(mockTriggerSeasonCompute).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('acknowledges a stale season only after its recovery and alert are handled', async () => {
    mockFreshnessAbort
      .mockResolvedValueOnce({ data: staleRow, error: null })
      .mockResolvedValueOnce({ data: freshRow, error: null })
      .mockResolvedValueOnce({ data: freshRow, error: null })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, stale: true, staleSeasons: ['90D'] })
    expect(mockTriggerSeasonCompute).toHaveBeenCalledWith(
      'https://www.arenafi.org',
      'cron-secret',
      '90D',
      { signal: expect.any(AbortSignal) }
    )
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'critical',
        title: 'compute-leaderboard 看门狗触发已确认',
      }),
      'compute-leaderboard-watchdog:triggered:90D',
      30 * 60 * 1000
    )
  })

  it('fails closed when a freshness query fails', async () => {
    mockFreshnessAbort.mockResolvedValueOnce({ data: null, error: { message: 'database offline' } })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('database offline')
    expect(mockTriggerSeasonCompute).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('fails the cron when recovery has no explicit acknowledgement', async () => {
    mockFreshnessAbort.mockResolvedValue({ data: staleRow, error: null })
    mockTriggerSeasonCompute.mockImplementation(async (_base, _secret, season) => ({
      season,
      triggered: season !== '30D',
      note: season === '30D' ? 'HTTP 503' : 'HTTP 200 acknowledged',
    }))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('Leaderboard recovery trigger failed for: 30D')
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'compute-leaderboard 看门狗触发失败' }),
      'compute-leaderboard-watchdog:failed:90D,30D,7D',
      30 * 60 * 1000
    )
  })

  it('fails when no alert channel handles an acknowledged recovery', async () => {
    mockFreshnessAbort.mockResolvedValueOnce({ data: staleRow, error: null })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: false,
      rateLimited: false,
      channels: [],
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('Leaderboard watchdog alert delivery failed')
  })

  it('accepts a deliberately rate-limited duplicate recovery alert', async () => {
    mockFreshnessAbort.mockResolvedValueOnce({ data: staleRow, error: null })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: true,
      rateLimited: true,
      channels: [],
    })

    await expect(GET(request())).resolves.toMatchObject({ status: 200 })
  })

  it('does not start recovery after the run deadline is exhausted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('watchdog deadline'))
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    mockFreshnessAbort.mockResolvedValue({ data: staleRow, error: null })

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockTriggerSeasonCompute).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })
})
