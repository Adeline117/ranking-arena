/**
 * @jest-environment node
 */

const mockRpcAbort = jest.fn()
const mockRpc = jest.fn(() => ({ abortSignal: mockRpcAbort }))
const mockSendRateLimitedAlert = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_jobName: string, handler: (request: unknown, context: unknown) => Promise<unknown>) =>
    async (request: unknown) => {
      try {
        const result = await handler(request, { supabase: { rpc: mockRpc } })
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

import { NextRequest } from 'next/server'
import { GET } from '../route'

const anomaly = {
  anomaly_type: 'roi_distribution_shift',
  platform: 'binance_futures',
  detail: 'median moved by 40%',
  severity: 'critical',
  count: 12,
}

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/scan-data-quality')
}

describe('GET /api/cron/scan-data-quality', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpcAbort.mockResolvedValue({ data: [], error: null })
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

  it('bounds the RPC and acknowledges an explicit empty scan', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, count: 0, message: 'No anomalies detected' })
    expect(timeoutSpy).toHaveBeenCalledWith(30_000)
    expect(mockRpc).toHaveBeenCalledWith('scan_data_quality_anomalies')
    expect(mockRpcAbort).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('fails closed on an RPC error', async () => {
    mockRpcAbort.mockResolvedValue({ data: null, error: { message: 'statement timeout' } })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('statement timeout')
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    [{ ...anomaly, count: undefined }],
    [{ ...anomaly, count: -1 }],
    [{ ...anomaly, platform: '' }],
    [{ ...anomaly, severity: 'CRITICAL' }],
  ])('fails closed on a malformed scan acknowledgement: %p', async (data) => {
    mockRpcAbort.mockResolvedValue({ data, error: null })

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('returns non-critical anomalies without paging operators', async () => {
    mockRpcAbort.mockResolvedValue({
      data: [{ ...anomaly, severity: 'warning' }],
      error: null,
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, count: 1 })
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('sends a bounded, escaped critical summary before acknowledging the scan', async () => {
    const data = Array.from({ length: 12 }, (_, index) => ({
      ...anomaly,
      anomaly_type: index === 0 ? '<bad&type>' : `anomaly-${index}`,
      detail: index === 0 ? '<script>'.repeat(100) : anomaly.detail,
      severity: index === 11 ? 'warning' : 'critical',
    }))
    mockRpcAbort.mockResolvedValue({ data, error: null })

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(mockSendRateLimitedAlert).toHaveBeenCalledTimes(1)
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('&lt;bad&amp;type&gt;'),
        details: {
          anomaly_count: 12,
          critical_count: 11,
          omitted_from_message: 2,
        },
      }),
      'scan-data-quality',
      12 * 60 * 60 * 1000
    )
    const payload = mockSendRateLimitedAlert.mock.calls[0][0]
    expect(payload.message).not.toContain('<script>')
    expect(payload.message).toContain('另有 2 个问题')
    expect(payload.message.length).toBeLessThan(4096)
  })

  it('fails when no channel handles a critical anomaly alert', async () => {
    mockRpcAbort.mockResolvedValue({ data: [anomaly], error: null })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: false,
      rateLimited: false,
      channels: [],
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('Critical data quality alert delivery failed')
  })

  it('accepts an intentionally rate-limited duplicate critical alert', async () => {
    mockRpcAbort.mockResolvedValue({ data: [anomaly], error: null })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: true,
      rateLimited: true,
      channels: [],
    })

    await expect(GET(request())).resolves.toMatchObject({ status: 200 })
  })

  it('does not alert or acknowledge a scan completed after its work deadline', async () => {
    const controller = new AbortController()
    controller.abort(new Error('scan deadline'))
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    mockRpcAbort.mockResolvedValue({ data: [anomaly], error: null })

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })
})
