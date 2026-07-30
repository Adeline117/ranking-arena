/**
 * @jest-environment node
 */

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

const mockBenchmarkUpsert = jest.fn()
const mockBenchmarkRead = jest.fn()
const mockConditionUpsert = jest.fn()
const mockFrom = jest.fn((table: string) => {
  if (table === 'market_benchmarks') {
    return {
      upsert: mockBenchmarkUpsert,
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            limit: mockBenchmarkRead,
          }),
        }),
      }),
    }
  }
  if (table === 'market_conditions') {
    return { upsert: mockConditionUpsert }
  }
  throw new Error(`Unexpected table: ${table}`)
})
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}))

jest.mock('@/lib/utils/market-correlation', () => ({
  detectMarketCondition: jest.fn(() => 'bull'),
  detectVolatilityRegime: jest.fn(() => 'normal'),
  calculateTrendStrength: jest.fn(() => 0.7),
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

jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: jest.fn(),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  apiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

jest.mock('@/lib/utils/pipeline-monitor', () => ({
  recordFetchResult: jest.fn(),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(),
  },
}))

const mockFetch = jest.fn()
global.fetch = mockFetch

import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { POST } from '../route'

const CRON_SECRET = 'test-secret'
const mockCreateClient = createClient as jest.Mock
const mockRecordFetchResult = recordFetchResult as jest.Mock
const mockPipelineStart = PipelineLogger.start as jest.Mock
const mockPipelineSuccess = jest.fn()
const mockPipelineError = jest.fn()

function createCronRequest(secret?: string, type?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  const search = type ? `?type=${encodeURIComponent(type)}` : ''
  return new NextRequest(`http://localhost:3000/api/cron/fetch-market-data${search}`, {
    method: 'POST',
    headers,
  })
}

function validPricePayload() {
  const now = Date.now()
  return {
    prices: [
      [now - 86_400_000, 60_000],
      [now, 61_000],
    ],
  }
}

function successfulUpstreamResponse() {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(validPricePayload()),
  }
}

describe('POST /api/cron/fetch-market-data', () => {
  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateClient.mockReturnValue(mockSupabaseClient)
    mockRecordFetchResult.mockResolvedValue(undefined)
    mockPipelineSuccess.mockResolvedValue(undefined)
    mockPipelineError.mockResolvedValue(undefined)
    mockPipelineStart.mockResolvedValue({
      id: 1,
      success: mockPipelineSuccess,
      error: mockPipelineError,
      timeout: jest.fn().mockResolvedValue(undefined),
    })
    mockFetch.mockResolvedValue(successfulUpstreamResponse())
    mockBenchmarkUpsert.mockResolvedValue({ error: null })
    mockBenchmarkRead.mockResolvedValue({
      data: Array.from({ length: 10 }, () => ({ daily_return_pct: 1.5 })),
      error: null,
    })
    mockConditionUpsert.mockResolvedValue({ error: null })
  })

  it('rejects missing or wrong cron credentials', async () => {
    await expect(POST(createCronRequest())).resolves.toMatchObject({ status: 401 })
    await expect(POST(createCronRequest('wrong'))).resolves.toMatchObject({ status: 401 })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects an unknown task type before starting work', async () => {
    const response = await POST(createCronRequest(CRON_SECRET, 'unknown'))
    expect(response.status).toBe(400)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('acknowledges only fully persisted BTC and ETH price/condition writes', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout')
    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      acknowledgement: {
        prices_expected: 2,
        prices_written: 2,
        conditions_written: 2,
        conditions_skipped: 0,
        durable_writes: 4,
        failures: [],
      },
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const [, init] of mockFetch.mock.calls) {
      expect(init.cache).toBe('no-store')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(timeoutSpy).toHaveBeenCalledTimes(2)
    expect(timeoutSpy).toHaveBeenCalledWith(12_000)
    timeoutSpy.mockRestore()
    expect(mockRecordFetchResult).toHaveBeenCalledWith(
      mockSupabaseClient,
      'market_data',
      expect.objectContaining({ success: true, recordCount: 4 })
    )
    expect(mockPipelineSuccess).toHaveBeenCalledWith(4, expect.any(Object))
    expect(mockPipelineError).not.toHaveBeenCalled()
  })

  it('keeps the legacy funding-only no-op explicit and does not fetch prices', async () => {
    const response = await POST(createCronRequest(CRON_SECRET, 'funding'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      acknowledgement: { prices_expected: 0, prices_written: 0, durable_writes: 0 },
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 503 and records failure when every upstream request fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 })

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      acknowledgement: {
        prices_written: 0,
        conditions_written: 0,
        durable_writes: 0,
      },
    })
    expect(body.acknowledgement.failures).toHaveLength(2)
    expect(mockRecordFetchResult).toHaveBeenCalledWith(
      mockSupabaseClient,
      'market_data',
      expect.objectContaining({ success: false, recordCount: 0 })
    )
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('treats upstream timeout as a failed no-write execution', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('upstream timed out'), { name: 'TimeoutError' })
    )

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.success).toBe(false)
    expect(body.acknowledgement.prices_written).toBe(0)
    expect(body.acknowledgement.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'upstream', error: 'upstream timed out' }),
      ])
    )
  })

  it('returns 207 and failure metrics when only one asset persists', async () => {
    mockFetch
      .mockResolvedValueOnce(successfulUpstreamResponse())
      .mockResolvedValueOnce({ ok: false, status: 429 })

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      acknowledgement: {
        prices_written: 1,
        conditions_written: 1,
        conditions_skipped: 1,
        durable_writes: 2,
      },
    })
    expect(body.acknowledgement.failures).toHaveLength(1)
    expect(mockRecordFetchResult).toHaveBeenCalledWith(
      mockSupabaseClient,
      'market_data',
      expect.objectContaining({ success: false, recordCount: 2 })
    )
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('does not count a failed benchmark upsert as a durable price write', async () => {
    mockBenchmarkUpsert
      .mockResolvedValueOnce({ error: { message: 'benchmark write unavailable' } })
      .mockResolvedValueOnce({ error: null })

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body.acknowledgement).toMatchObject({ prices_written: 1, conditions_written: 1 })
    expect(body.acknowledgement.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: 'benchmark_write', symbol: 'BTC' })])
    )
  })

  it('returns 503 when valid upstream payloads produce zero durable benchmark writes', async () => {
    mockBenchmarkUpsert.mockResolvedValue({ error: { message: 'benchmark database unavailable' } })

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      acknowledgement: { prices_written: 0, durable_writes: 0 },
    })
    expect(body.acknowledgement.failures).toEqual([
      expect.objectContaining({ stage: 'benchmark_write', symbol: 'BTC' }),
      expect.objectContaining({ stage: 'benchmark_write', symbol: 'ETH' }),
    ])
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })

  it('does not report success when condition history queries fail', async () => {
    mockBenchmarkRead.mockResolvedValue({
      data: null,
      error: { message: 'benchmark read unavailable' },
    })

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body.acknowledgement).toMatchObject({ prices_written: 2, conditions_written: 0 })
    expect(body.acknowledgement.failures).toHaveLength(2)
    expect(body.acknowledgement.failures[0]).toMatchObject({ stage: 'condition_read' })
    expect(mockConditionUpsert).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })

  it('rejects non-finite or out-of-range upstream payloads before database writes', async () => {
    const now = Date.now()
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        prices: [
          [now - 86_400_000, 60_000],
          [now, Number.POSITIVE_INFINITY],
        ],
      }),
    })

    const response = await POST(createCronRequest(CRON_SECRET, 'prices'))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.acknowledgement.prices_written).toBe(0)
    expect(mockBenchmarkUpsert).not.toHaveBeenCalled()
  })
})
