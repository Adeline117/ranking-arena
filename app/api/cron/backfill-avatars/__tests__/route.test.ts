/**
 * @jest-environment node
 */

const mockReadAbort = jest.fn()
const mockUpdateAbort = jest.fn()
const mockReadBuilder: Record<string, jest.Mock> = {}
mockReadBuilder.eq = jest.fn(() => mockReadBuilder)
mockReadBuilder.is = jest.fn(() => mockReadBuilder)
mockReadBuilder.order = jest.fn(() => mockReadBuilder)
mockReadBuilder.range = jest.fn(() => mockReadBuilder)
mockReadBuilder.abortSignal = mockReadAbort

const mockSelect = jest.fn(() => mockReadBuilder)
const mockUpdate = jest.fn(() => ({
  eq: jest.fn((_column: string, id: string | number) => ({
    select: jest.fn(() => ({
      abortSignal: (signal: AbortSignal) => mockUpdateAbort(id, signal),
    })),
  })),
}))
const mockFrom = jest.fn(() => ({ select: mockSelect, update: mockUpdate }))

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
  getSupabaseAdmin: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: { start: jest.fn() },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/constants/exchanges', () => ({
  DEAD_BLOCKED_PLATFORMS: ['drift'],
}))

const mockFetch = jest.fn()
global.fetch = mockFetch

import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { GET } from '../route'

const CRON_SECRET = 'test-secret'
const mockPipelineStart = PipelineLogger.start as jest.Mock
const mockPipelineSuccess = jest.fn()
const mockPipelinePartialSuccess = jest.fn()
const mockPipelineError = jest.fn()

const trader = { id: 1, source_trader_id: 'leader-1', handle: 'alice' }

function request(
  platform?: string,
  options: { secret?: string; mode?: string; limit?: number } = {}
) {
  const url = new URL('https://arena.test/api/cron/backfill-avatars')
  if (platform !== undefined) url.searchParams.set('platform', platform)
  if (options.mode) url.searchParams.set('mode', options.mode)
  if (options.limit) url.searchParams.set('limit', String(options.limit))
  const headers = new Headers()
  if (options.secret) headers.set('authorization', `Bearer ${options.secret}`)
  return new Request(url, { headers })
}

function avatarResponse() {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ data: { avatar: 'https://cdn.test/avatar.png' } }),
  }
}

describe('GET /api/cron/backfill-avatars', () => {
  let timeoutSpy: jest.SpyInstance
  const realSetTimeout = global.setTimeout

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockReadAbort.mockResolvedValue({ data: [trader], error: null })
    mockUpdateAbort.mockImplementation(async (id: string | number) => ({
      data: [{ id }],
      error: null,
    }))
    mockFetch.mockResolvedValue(avatarResponse())
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

    timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 1500 || delay === 3000) {
        callback(...args)
        return 0 as unknown as ReturnType<typeof setTimeout>
      }
      return realSetTimeout(callback, delay, ...args)
    }) as typeof setTimeout)
  })

  afterEach(() => {
    timeoutSpy.mockRestore()
  })

  it('rejects missing and incorrect cron credentials before starting a pipeline log', async () => {
    await expect(GET(request('phemex'))).resolves.toMatchObject({ status: 401 })
    await expect(GET(request('phemex', { secret: 'wrong' }))).resolves.toMatchObject({
      status: 401,
    })
    expect(mockPipelineStart).not.toHaveBeenCalled()
  })

  it('rejects unsupported platforms instead of reporting a zero-row success', async () => {
    const response = await GET(request('toobit', { secret: CRON_SECRET }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      success: false,
      status: 'failed',
      platform: 'toobit',
      updated: 0,
      errors: 1,
    })
    expect(mockReadAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the missing-avatar query returns an error', async () => {
    mockReadAbort.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await GET(request('phemex', { secret: CRON_SECRET, mode: 'individual' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toMatchObject({ success: false, status: 'failed', errors: 1 })
    expect(body.message).toContain('database unavailable')
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('acknowledges an explicit no-op when no avatar rows are missing', async () => {
    mockReadAbort.mockResolvedValue({ data: [], error: null })

    const response = await GET(request('phemex', { secret: CRON_SECRET, mode: 'individual' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      total: 0,
      updated: 0,
      errors: 0,
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).toHaveBeenCalledTimes(1)
  })

  it('counts an avatar only after the exact database row is acknowledged', async () => {
    const response = await GET(request('phemex', { secret: CRON_SECRET, mode: 'individual' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      status: 'success',
      total: 1,
      updated: 1,
      errors: 0,
    })
    expect(mockUpdateAbort).toHaveBeenCalledWith(1, expect.any(AbortSignal))
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('leader-1'),
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
    expect(mockPipelineSuccess).toHaveBeenCalledTimes(1)
  })

  it('returns 503 when an upstream failure leaves every candidate unchanged', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 })

    const response = await GET(request('phemex', { secret: CRON_SECRET, mode: 'individual' }))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ success: false, status: 'failed', updated: 0, errors: 1 })
    expect(mockUpdateAbort).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('returns 503 when the database does not acknowledge the updated row', async () => {
    mockUpdateAbort.mockResolvedValue({ data: [], error: null })

    const response = await GET(request('phemex', { secret: CRON_SECRET, mode: 'individual' }))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ success: false, status: 'failed', updated: 0, errors: 1 })
    expect(mockPipelineError).toHaveBeenCalledTimes(1)
  })

  it('reports partial success when one of two individual fetches fails', async () => {
    mockReadAbort.mockResolvedValue({
      data: [trader, { id: 2, source_trader_id: 'leader-2', handle: 'bob' }],
      error: null,
    })
    mockFetch
      .mockResolvedValueOnce(avatarResponse())
      .mockResolvedValueOnce({ ok: false, status: 503 })

    const response = await GET(
      request('phemex', { secret: CRON_SECRET, mode: 'individual', limit: 2 })
    )
    const body = await response.json()

    expect(response.status).toBe(207)
    expect(body).toMatchObject({
      success: false,
      status: 'partial',
      total: 2,
      updated: 1,
      errors: 1,
    })
    expect(mockPipelinePartialSuccess).toHaveBeenCalledTimes(1)
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })

  it('bounds and acknowledges a bulk avatar write', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: { itemList: [{ userSign: 'leader-1', imgUrl: 'https://cdn.test/bulk.png' }] },
      }),
    })

    const response = await GET(request('htx', { secret: CRON_SECRET, mode: 'bulk' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, status: 'success', updated: 1, errors: 0 })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('copytrading/rank'),
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    )
    expect(mockUpdateAbort).toHaveBeenCalledTimes(1)
  })

  it('does not report a bulk run successful when candidates exist but no avatar is fetched', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ data: { itemList: [] } }),
    })

    const response = await GET(request('htx', { secret: CRON_SECRET, mode: 'bulk' }))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ success: false, status: 'failed', updated: 0, errors: 1 })
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
  })

  it('fails the stale scheduled platform bundle instead of logging it successful', async () => {
    const response = await GET(
      request('drift,toobit,bitfinex,etoro,gains', { secret: CRON_SECRET, limit: 400 })
    )
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ success: false, status: 'failed', updated: 0 })
    expect(body.platforms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: 'drift', status: 'skipped' }),
        expect.objectContaining({ platform: 'toobit', status: 'failed' }),
        expect.objectContaining({ platform: 'bitfinex', status: 'failed' }),
        expect.objectContaining({ platform: 'etoro', status: 'failed' }),
        expect.objectContaining({ platform: 'gains', status: 'failed' }),
      ])
    )
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockPipelineSuccess).not.toHaveBeenCalled()
    expect(mockPipelineError).toHaveBeenCalledTimes(5)
  })

  it('fails before reading or fetching when the work deadline is already exhausted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('deadline'))
    const abortSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)

    const response = await GET(request('phemex', { secret: CRON_SECRET, mode: 'individual' }))
    const body = await response.json()

    expect(response.status).toBe(504)
    expect(body).toMatchObject({ success: false, status: 'failed', updated: 0, errors: 1 })
    expect(mockFetch).not.toHaveBeenCalled()
    abortSpy.mockRestore()
  })
})
