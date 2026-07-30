/**
 * @jest-environment node
 */

const mockDbAbort = jest.fn()
const mockUpsert = jest.fn(() => ({ abortSignal: mockDbAbort }))
const mockFrom = jest.fn(() => ({ upsert: mockUpsert }))
const mockSupabase = { from: mockFrom }

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'CRON_SECRET') return process.env.CRON_SECRET
        return process.env[String(key)]
      },
    }
  ),
}))

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    dbError: jest.fn(),
    apiError: jest.fn(),
  },
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(),
  },
}))

const mockFetch = jest.fn()
global.fetch = mockFetch

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { POST } from '../route'

const CRON_SECRET = 'test-secret'
const mockGetSupabaseAdmin = getSupabaseAdmin as jest.Mock
const mockPipelineStart = PipelineLogger.start as jest.Mock
const mockPipelineSuccess = jest.fn()
const mockPipelinePartialSuccess = jest.fn()
const mockPipelineError = jest.fn()

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/fetch-funding-rates', {
    method: 'POST',
    headers,
  })
}

function successfulPayload(url: string): unknown {
  const parsed = new URL(url)
  const now = String(Date.now())
  const symbol = parsed.searchParams.get('symbol') || parsed.searchParams.get('instId') || 'BTCUSDT'

  if (url.includes('binance.com')) {
    return [{ fundingRate: '0.0001', fundingTime: now }]
  }
  if (url.includes('bybit.com')) {
    return {
      result: {
        list: [{ symbol, fundingRate: '0.0001', fundingRateTimestamp: now }],
      },
    }
  }
  if (url.includes('okx.com')) {
    return { data: [{ instId: symbol, fundingRate: '0.0001', fundingTime: now }] }
  }
  return { data: [{ symbol, fundingRate: '0.0001', nextUpdate: now }] }
}

function successfulResponse(url: string) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(successfulPayload(url)),
  }
}

describe('POST /api/cron/fetch-funding-rates', () => {
  let timeoutSpy: jest.SpyInstance
  const realSetTimeout = global.setTimeout

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSupabaseAdmin.mockReturnValue(mockSupabase)
    mockDbAbort.mockResolvedValue({ error: null })
    mockPipelineSuccess.mockResolvedValue(undefined)
    mockPipelinePartialSuccess.mockResolvedValue(undefined)
    mockPipelineError.mockResolvedValue(undefined)
    mockPipelineStart.mockResolvedValue({
      id: 1,
      success: mockPipelineSuccess,
      partialSuccess: mockPipelinePartialSuccess,
      error: mockPipelineError,
      timeout: jest.fn().mockResolvedValue(undefined),
    })
    mockFetch.mockImplementation(async (url: string) => successfulResponse(url))

    timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 200) {
        callback(...args)
        return 0 as unknown as ReturnType<typeof setTimeout>
      }
      return realSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
  })

  afterEach(() => {
    timeoutSpy.mockRestore()
  })

  it('rejects missing or incorrect cron credentials before doing work', async () => {
    await expect(POST(createCronRequest())).resolves.toMatchObject({ status: 401 })
    await expect(POST(createCronRequest('wrong'))).resolves.toMatchObject({ status: 401 })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockPipelineStart).not.toHaveBeenCalled()
  })

  it('reports success only after every expected rate is durably written', async () => {
    const abortSpy = jest.spyOn(AbortSignal, 'timeout')
    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      acknowledgement: {
        expected: 80,
        attempted: 80,
        upstream_succeeded: 80,
        fetched: 80,
        inserted: 80,
        durable_writes: 80,
        unattempted: 0,
        failures: [],
      },
    })
    expect(mockFetch).toHaveBeenCalledTimes(80)
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.cache).toBe('no-store')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(abortSpy).toHaveBeenCalledWith(12_000)
    expect(mockPipelineSuccess).toHaveBeenCalledWith(80, expect.any(Object))
    expect(mockPipelinePartialSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).not.toHaveBeenCalled()
    abortSpy.mockRestore()
  })

  it('returns 503 and records failure when every upstream request fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      acknowledgement: {
        expected: 80,
        attempted: 80,
        upstream_succeeded: 0,
        fetched: 0,
        inserted: 0,
        durable_writes: 0,
      },
    })
    expect(body.acknowledgement.failures).toHaveLength(80)
    expect(mockDbAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelinePartialSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('returns 207 and records partial success when only one upstream request survives', async () => {
    let calls = 0
    mockFetch.mockImplementation(async (url: string) => {
      calls++
      return calls === 1 ? successfulResponse(url) : { ok: false, status: 503 }
    })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      acknowledgement: {
        upstream_succeeded: 1,
        fetched: 1,
        inserted: 1,
        durable_writes: 1,
      },
    })
    expect(body.acknowledgement.failures).toHaveLength(79)
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelinePartialSuccess).toHaveBeenCalledWith(
      1,
      expect.arrayContaining([expect.stringContaining(':upstream')]),
      expect.any(Object)
    )
    expect(mockPipelineError).not.toHaveBeenCalled()
  })

  it('returns 503 when upstream succeeds but every database write fails', async () => {
    mockDbAbort.mockResolvedValue({ error: { message: 'database unavailable' } })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      acknowledgement: {
        upstream_succeeded: 80,
        fetched: 80,
        inserted: 0,
        durable_writes: 0,
      },
    })
    expect(body.acknowledgement.failures).toHaveLength(80)
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('does not count a rejected database write and reports a partial run', async () => {
    mockDbAbort
      .mockRejectedValueOnce(new Error('database timed out'))
      .mockResolvedValue({ error: null })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      acknowledgement: { fetched: 80, inserted: 79, durable_writes: 79 },
    })
    expect(body.acknowledgement.failures).toEqual([
      expect.objectContaining({ stage: 'database', error: 'database timed out' }),
    ])
    expect(mockPipelinePartialSuccess).toHaveBeenCalledTimes(1)
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })

  it('treats timeouts as failed attempts instead of a successful zero-row run', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('upstream timed out'), { name: 'TimeoutError' })
    )

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.acknowledgement).toMatchObject({ inserted: 0, durable_writes: 0 })
    expect(body.acknowledgement.failures).toHaveLength(80)
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('rejects non-finite funding rates before any database write', async () => {
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: jest
        .fn()
        .mockResolvedValue(
          url.includes('binance.com')
            ? [{ fundingRate: 'Infinity', fundingTime: String(Date.now()) }]
            : { data: [] }
        ),
    }))

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.acknowledgement.failures).toHaveLength(80)
    expect(body.acknowledgement.failures[0]).toMatchObject({ stage: 'validation' })
    expect(mockDbAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })
})
