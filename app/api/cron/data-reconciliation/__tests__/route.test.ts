/**
 * @jest-environment node
 */

const mockRpcAbort = jest.fn()
const mockRpc = jest.fn((name: string) => ({
  abortSignal: (signal: AbortSignal) => mockRpcAbort(name, signal),
}))
const mockPipelineSet = jest.fn()
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

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    set: (...args: unknown[]) => mockPipelineSet(...args),
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const NOW = Date.parse('2026-07-29T10:00:00.000Z')
const summary = [
  {
    source: 'binance_futures',
    gap_count: 2,
    avg_gap_hours: 60,
    max_gap_hours: 72,
  },
]
const details = [
  {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    last_computed: new Date(NOW - 60 * 60 * 60 * 1000).toISOString(),
    gap_hours: 60,
  },
  {
    source: 'binance_futures',
    source_trader_id: 'trader-2',
    last_computed: null,
    gap_hours: 50_000,
  },
]

function request(): NextRequest {
  return new NextRequest('https://arena.test/api/cron/data-reconciliation')
}

function rpcResults(summaryData: unknown = summary, detailData: unknown = details): void {
  mockRpcAbort.mockImplementation(async (name: string) => {
    if (name === 'get_data_gap_summary') return { data: summaryData, error: null }
    if (name === 'find_data_gaps') return { data: detailData, error: null }
    throw new Error(`Unexpected RPC ${name}`)
  })
}

describe('GET /api/cron/data-reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
    rpcResults()
    mockPipelineSet.mockResolvedValue(undefined)
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

  it('acknowledges an exact empty summary under a bounded query', async () => {
    rpcResults([])
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, count: 0, message: 'No data gaps detected' })
    expect(timeoutSpy).toHaveBeenCalledWith(90_000)
    expect(mockRpc).toHaveBeenCalledWith('get_data_gap_summary', { p_max_age_hours: 48 })
    expect(mockRpc).not.toHaveBeenCalledWith('find_data_gaps', expect.anything())
    expect(mockPipelineSet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    [{ ...summary[0], gap_count: '2' }],
    [{ ...summary[0], gap_count: 0 }],
    [{ ...summary[0], avg_gap_hours: Number.NaN }],
    [{ ...summary[0], unexpected: true }],
    [summary[0], summary[0]],
    [
      { ...summary[0], gap_count: Number.MAX_SAFE_INTEGER },
      { ...summary[0], source: 'bybit', gap_count: Number.MAX_SAFE_INTEGER },
    ],
  ])('fails closed on a malformed summary acknowledgement: %p', async (payload) => {
    rpcResults(payload)

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockPipelineSet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    [{ ...details[0], source: 'unknown' }],
    [{ ...details[0], source_trader_id: '' }],
    [{ ...details[0], gap_hours: 47 }],
    [{ ...details[0], last_computed: new Date(NOW).toISOString() }],
    [{ ...details[0], unexpected: true }],
    [details[0], details[0]],
  ])('fails closed on incomplete or malformed gap details: %p', async (payload) => {
    rpcResults(summary, payload)

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockPipelineSet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('persists bounded retry state and requires an handled alert before success', async () => {
    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, count: 2, platforms_affected: 1 })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'find_data_gaps', {
      p_max_age_hours: 48,
      p_limit: 500,
    })
    expect(mockPipelineSet).toHaveBeenCalledWith(
      'reconciliation:gaps:binance_futures',
      expect.objectContaining({ traderIds: ['trader-1', 'trader-2'], count: 2 }),
      { signal: expect.any(AbortSignal) }
    )
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        details: { platforms: 1, total_gaps: 2 },
      }),
      'data-reconciliation:daily',
      20 * 60 * 60 * 1000
    )
  })

  it('fails before alerting when durable retry-state persistence fails', async () => {
    mockPipelineSet.mockRejectedValue(new Error('pipeline state unavailable'))

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('pipeline state unavailable')
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })

  it('fails when no channel handles the data-gap alert', async () => {
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: false,
      rateLimited: false,
      channels: [],
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('Data reconciliation alert delivery failed')
  })

  it('accepts an intentionally rate-limited duplicate data-gap alert', async () => {
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      handled: true,
      rateLimited: true,
      channels: [],
    })

    await expect(GET(request())).resolves.toMatchObject({ status: 200 })
  })

  it('does not persist or alert after the run deadline is exhausted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('reconciliation deadline'))
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockPipelineSet).not.toHaveBeenCalled()
    expect(mockSendRateLimitedAlert).not.toHaveBeenCalled()
  })
})
