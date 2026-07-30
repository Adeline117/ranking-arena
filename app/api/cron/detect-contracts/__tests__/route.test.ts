/**
 * @jest-environment node
 */

const mockReadAbort = jest.fn()
const mockUpdateAbort = jest.fn()
const mockReadLimit = jest.fn()
const mockReadBuilder: Record<string, jest.Mock> = {}
mockReadBuilder.in = jest.fn(() => mockReadBuilder)
mockReadBuilder.is = jest.fn(() => mockReadBuilder)
mockReadBuilder.like = jest.fn(() => mockReadBuilder)
mockReadBuilder.limit = mockReadLimit.mockImplementation(() => mockReadBuilder)
mockReadBuilder.abortSignal = mockReadAbort

function updateConfirmation(ids: number[]) {
  return {
    select: jest.fn(() => ({
      abortSignal: (signal: AbortSignal) => mockUpdateAbort(ids, signal),
    })),
  }
}

const mockUpdateEq = jest.fn((_column: string, id: number) => updateConfirmation([id]))
const mockUpdateIn = jest.fn((_column: string, ids: number[]) => updateConfirmation(ids))
const mockUpdate = jest.fn(() => ({ eq: mockUpdateEq, in: mockUpdateIn }))
const mockSelect = jest.fn(() => mockReadBuilder)
const mockFrom = jest.fn(() => ({ select: mockSelect, update: mockUpdate }))
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

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabase),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: { start: jest.fn() },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/services/contract-detector', () => ({
  DEX_CHAIN_MAP: { gmx: 42161 },
  getChainForPlatform: jest.fn(() => 42161),
  isBotContract: jest.fn((result: { isContract: boolean; bytecodeSize: number }) =>
    Boolean(result.isContract && result.bytecodeSize >= 100)
  ),
  batchCheckContracts: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { batchCheckContracts } from '@/lib/services/contract-detector'
import { GET } from '../route'

const CRON_SECRET = 'test-secret'
const mockBatchCheck = batchCheckContracts as jest.Mock
const mockPipelineStart = PipelineLogger.start as jest.Mock
const mockPipelineSuccess = jest.fn()
const mockPipelinePartialSuccess = jest.fn()
const mockPipelineError = jest.fn()

const ADDRESSES = [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`, `0x${'3'.repeat(40)}`] as const
const rows = [
  { id: 1, source: 'gmx', source_trader_id: ADDRESSES[0] },
  { id: 2, source: 'gmx', source_trader_id: ADDRESSES[1] },
  { id: 3, source: 'gmx', source_trader_id: ADDRESSES[2] },
]

function createRequest(secret?: string, limit?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  const search = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`
  return new NextRequest(`http://localhost:3000/api/cron/detect-contracts${search}`, {
    headers,
  })
}

function completeClassifications() {
  return new Map([
    [ADDRESSES[0], { isContract: true, bytecodeSize: 200 }],
    [ADDRESSES[1], { isContract: true, bytecodeSize: 23 }],
    [ADDRESSES[2], { isContract: false, bytecodeSize: 0 }],
  ])
}

describe('GET /api/cron/detect-contracts', () => {
  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockReadAbort.mockResolvedValue({ data: rows, error: null })
    mockUpdateAbort.mockImplementation(async (ids: number[]) => ({
      data: ids.map((id) => ({ id })),
      error: null,
    }))
    mockBatchCheck.mockResolvedValue(completeClassifications())
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
  })

  it('rejects missing and incorrect cron credentials before reading data', async () => {
    await expect(GET(createRequest())).resolves.toMatchObject({ status: 401 })
    await expect(GET(createRequest('wrong'))).resolves.toMatchObject({ status: 401 })
    expect(mockReadAbort).not.toHaveBeenCalled()
    expect(mockPipelineStart).not.toHaveBeenCalled()
  })

  it('treats a valid empty source set as an explicit successful no-op', async () => {
    mockReadAbort.mockResolvedValue({ data: [], error: null })

    const response = await GET(createRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      checked: 0,
      acknowledgement: { expected: 0, durable_writes: 0, failures: [] },
    })
    expect(mockBatchCheck).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).toHaveBeenCalledWith(0)
  })

  it('reports success only after every classification update is confirmed', async () => {
    const response = await GET(createRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      checked: 3,
      bots: 1,
      proxies: 1,
      eoas: 1,
      errors: 0,
      acknowledgement: {
        expected: 3,
        rpc_attempted: 3,
        classified: 3,
        durable_writes: 3,
        failure_count: 0,
      },
    })
    expect(mockBatchCheck).toHaveBeenCalledWith(ADDRESSES, 42161, 20, expect.any(AbortSignal))
    expect(mockUpdateAbort).toHaveBeenCalledTimes(3)
    expect(mockPipelineSuccess).toHaveBeenCalledWith(3, expect.any(Object))
    expect(mockPipelinePartialSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).not.toHaveBeenCalled()
  })

  it('returns 503 when every RPC classification fails', async () => {
    mockBatchCheck.mockResolvedValue(
      new Map(rows.map((row) => [row.source_trader_id, null] as const))
    )

    const response = await GET(createRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      checked: 0,
      errors: 3,
      acknowledgement: { classified: 0, durable_writes: 0, failure_count: 3 },
    })
    expect(mockUpdateAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('returns 207 and records partial success for incomplete RPC results', async () => {
    const classifications = completeClassifications()
    classifications.set(ADDRESSES[2], null as never)
    mockBatchCheck.mockResolvedValue(classifications)

    const response = await GET(createRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      checked: 2,
      bots: 1,
      proxies: 1,
      eoas: 0,
      errors: 1,
    })
    expect(mockPipelinePartialSuccess).toHaveBeenCalledTimes(1)
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })

  it('returns 503 when classifications succeed but every database write fails', async () => {
    mockUpdateAbort.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await GET(createRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      checked: 0,
      acknowledgement: { classified: 3, durable_writes: 0, failure_count: 3 },
    })
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('does not count a partial database acknowledgement as a durable batch', async () => {
    mockReadAbort.mockResolvedValue({
      data: rows.slice(0, 2),
      error: null,
    })
    mockBatchCheck.mockResolvedValue(
      new Map([
        [ADDRESSES[0], { isContract: false, bytecodeSize: 0 }],
        [ADDRESSES[1], { isContract: false, bytecodeSize: 0 }],
      ])
    )
    mockUpdateAbort.mockResolvedValue({ data: [{ id: 1 }], error: null })

    const response = await GET(createRequest(CRON_SECRET))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ checked: 0, errors: 2 })
    expect(body.acknowledgement.failures[0]).toMatchObject({
      stage: 'database',
      affected: 2,
    })
  })

  it('fails closed on read errors and isolates malformed source rows', async () => {
    mockReadAbort.mockResolvedValueOnce({ data: null, error: { message: 'read failed' } })
    const readFailure = await GET(createRequest(CRON_SECRET))
    expect(readFailure.status).toBe(500)

    mockReadAbort.mockResolvedValueOnce({
      data: [{ id: 1, source: 'gmx', source_trader_id: 'not-an-address' }],
      error: null,
    })
    const malformed = await GET(createRequest(CRON_SECRET))
    expect(malformed.status).toBe(503)
    await expect(malformed.json()).resolves.toMatchObject({
      success: false,
      checked: 0,
      errors: 1,
      acknowledgement: {
        failure_count: 1,
        failures: [expect.objectContaining({ stage: 'validation', affected: 1 })],
      },
    })
  })

  it('caps invalid requested limits and fails instead of starting work past its budget', async () => {
    const controller = new AbortController()
    controller.abort(new Error('deadline'))
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const response = await GET(createRequest(CRON_SECRET, 'not-a-number'))
    const body = await response.json()

    expect(mockReadLimit).toHaveBeenCalledWith(500)
    expect(mockBatchCheck).not.toHaveBeenCalled()
    expect(response.status).toBe(503)
    expect(body).toMatchObject({ success: false, status: 'failed', checked: 0, errors: 3 })
    expect(body.acknowledgement.failures[0]).toMatchObject({ stage: 'budget', affected: 3 })
    timeoutSpy.mockRestore()
  })
})
