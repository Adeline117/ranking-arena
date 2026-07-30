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
  return new NextRequest('http://localhost:3000/api/cron/fetch-open-interest', {
    method: 'POST',
    headers,
  })
}

function payloadFor(url: string): unknown {
  const parsed = new URL(url)
  const now = String(Date.now())
  const symbol = parsed.searchParams.get('symbol') || parsed.searchParams.get('instId') || 'BTCUSDT'

  if (url.includes('binance.com/fapi/v1/openInterest')) {
    return { symbol, openInterest: '100' }
  }
  if (url.includes('binance.com/fapi/v1/premiumIndex')) {
    return { markPrice: '50000' }
  }
  if (url.includes('bybit.com/v5/market/open-interest')) {
    return { result: { list: [{ symbol, openInterest: '100', timestamp: now }] } }
  }
  if (url.includes('bybit.com/v5/market/tickers')) {
    return { result: { list: [{ lastPrice: '100' }] } }
  }
  if (url.includes('okx.com')) {
    return { data: [{ instId: symbol, oiUsd: '100000', oiCcy: '50', ts: now }] }
  }
  if (url.includes('bitget.com/api/v2/mix/market/open-interest')) {
    return { data: { openInterestList: [{ symbol, size: '100' }] } }
  }
  return { data: [{ lastPr: '100' }] }
}

function successfulResponse(url: string) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(payloadFor(url)),
  }
}

describe('POST /api/cron/fetch-open-interest', () => {
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

  it('reports success only after all 80 expected observations are durably written', async () => {
    const abortSpy = jest.spyOn(AbortSignal, 'timeout')
    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      fetched: 80,
      inserted: 80,
      errors: 0,
      acknowledgement: {
        expected: 80,
        attempted: 80,
        upstream_succeeded: 80,
        durable_writes: 80,
        unattempted: 0,
        failures: [],
      },
    })
    expect(mockFetch).toHaveBeenCalledTimes(140)
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.cache).toBe('no-store')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(abortSpy).toHaveBeenCalledWith(12_000)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'binance',
        symbol: 'BTCUSDT',
        open_interest_usd: 5_000_000,
        open_interest_contracts: 100,
      }),
      { onConflict: 'platform,symbol,timestamp' }
    )
    expect(mockPipelineSuccess).toHaveBeenCalledWith(80, expect.any(Object))
    expect(mockPipelinePartialSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).not.toHaveBeenCalled()
    abortSpy.mockRestore()
  })

  it('returns 503 and records failure when every primary upstream request fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      fetched: 0,
      inserted: 0,
      acknowledgement: { attempted: 80, upstream_succeeded: 0, durable_writes: 0 },
    })
    expect(body.acknowledgement.failures).toHaveLength(80)
    expect(mockDbAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelinePartialSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('returns 207 when only one complete observation survives', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const isFirstSymbol = new URL(url).searchParams.get('symbol') === 'BTCUSDT'
      return isFirstSymbol && url.includes('binance.com')
        ? successfulResponse(url)
        : { ok: false, status: 503 }
    })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      fetched: 1,
      inserted: 1,
      acknowledgement: { upstream_succeeded: 1, durable_writes: 1 },
    })
    expect(body.acknowledgement.failures).toHaveLength(79)
    expect(mockPipelinePartialSuccess).toHaveBeenCalledTimes(1)
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).not.toHaveBeenCalled()
  })

  it('does not persist a fake $0 observation when a required price fetch fails', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (
        url.includes('premiumIndex') ||
        url.includes('/market/tickers') ||
        url.includes('/market/ticker?')
      ) {
        return { ok: false, status: 503 }
      }
      return successfulResponse(url)
    })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      fetched: 20,
      inserted: 20,
      acknowledgement: { upstream_succeeded: 20, durable_writes: 20 },
    })
    expect(body.acknowledgement.failures).toHaveLength(60)
    expect(body.acknowledgement.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'price' })])
    )
    expect(mockDbAbort).toHaveBeenCalledTimes(20)
  })

  it('returns 503 when upstream succeeds but every database write fails', async () => {
    mockDbAbort.mockResolvedValue({ error: { message: 'database unavailable' } })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      fetched: 80,
      inserted: 0,
      acknowledgement: { upstream_succeeded: 80, durable_writes: 0 },
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
      fetched: 80,
      inserted: 79,
      acknowledgement: { durable_writes: 79 },
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

  it('rejects non-finite OI and price values before database writes', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const payload = payloadFor(url)
      if (url.includes('premiumIndex')) {
        return {
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({ markPrice: 'Infinity' }),
        }
      }
      if (url.includes('okx.com')) {
        const parsed = new URL(url)
        return {
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({
            data: [
              {
                instId: parsed.searchParams.get('instId'),
                oiUsd: 'Infinity',
                oiCcy: '50',
                ts: String(Date.now()),
              },
            ],
          }),
        }
      }
      if (url.includes('bybit.com/v5/market/open-interest')) {
        return {
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({
            result: {
              list: [
                {
                  symbol: new URL(url).searchParams.get('symbol'),
                  openInterest: 'Infinity',
                  timestamp: String(Date.now()),
                },
              ],
            },
          }),
        }
      }
      if (url.includes('bitget.com/api/v2/mix/market/open-interest')) {
        return {
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({
            data: {
              openInterestList: [
                { symbol: new URL(url).searchParams.get('symbol'), size: 'Infinity' },
              ],
            },
          }),
        }
      }
      return { ok: true, status: 200, json: jest.fn().mockResolvedValue(payload) }
    })

    const response = await POST(createCronRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.acknowledgement.failures).toHaveLength(80)
    expect(mockDbAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })
})
