/** @jest-environment node */

const mockExtractUserFromRequest = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockAbortSignal = jest.fn()

jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUserFromRequest(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
}))

import type { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = 'a'.repeat(32)
const SHARE_TOKEN = 'b'.repeat(32)

function trader(rank: number, overrides: Record<string, unknown> = {}) {
  return {
    rank,
    trader_id: `trader-${rank}`,
    handle: `handle-${rank}`,
    source: 'binance_futures',
    avatar_url: null,
    roi: 20 - rank,
    pnl: 1000 - rank,
    win_rate: 55,
    max_drawdown: 8,
    trades_count: 10,
    followers: 20,
    arena_score: 70,
    return_score: 60,
    drawdown_score: 65,
    stability_score: 50,
    data_availability: { roi: true, pnl: true },
    ...overrides,
  }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'create_snapshot',
    request_id: REQUEST_ID,
    exchange: 'all',
    time_range: '90D',
    traders: [trader(1), trader(2)],
    ...overrides,
  }
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    status: 'created',
    applied: true,
    operation: 'create_snapshot',
    actor_id: ACTOR_ID,
    request_id: REQUEST_ID,
    snapshot: {
      id: SNAPSHOT_ID,
      share_token: SHARE_TOKEN,
      created_by: ACTOR_ID,
      exchange: 'all',
      time_range: '90D',
      total_traders: 2,
      top_trader_handle: 'handle-1',
      top_trader_roi: 19,
      data_captured_at: '2026-08-03T12:00:00.000Z',
      expires_at: '2026-08-10T12:00:00.000Z',
    },
    ...overrides,
  }
}

function request(value: unknown = body(), headers?: Record<string, string>): NextRequest {
  return new Request('https://www.arenafi.org/api/ranking-snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  }) as NextRequest
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Pragma')).toBe('no-cache')
  expect(response.headers.get('Vary')).toBe('Authorization, Cookie')
}

describe('POST /api/ranking-snapshot atomic create contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockExtractUserFromRequest.mockResolvedValue({ user: { id: ACTOR_ID }, error: null })
    mockAbortSignal.mockResolvedValue({ data: acknowledgement(), error: null })
    mockRpc.mockReturnValue({ abortSignal: mockAbortSignal })
  })

  it('submits every trader to one actor/request-bound RPC and returns a private receipt', async () => {
    const response = await POST(request())

    expect(response.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith('create_ranking_snapshot_atomic', {
      p_actor_id: ACTOR_ID,
      p_request_id: REQUEST_ID,
      p_exchange: 'all',
      p_time_range: '90D',
      p_traders: [trader(1), trader(2)],
    })
    expect(mockAbortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(mockFrom).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      operation: 'create_snapshot',
      request_id: REQUEST_ID,
      actor_id: ACTOR_ID,
      status: 'created',
      applied: true,
      snapshot: {
        id: SNAPSHOT_ID,
        share_token: SHARE_TOKEN,
        url: `/s/${SHARE_TOKEN}`,
        expires_at: '2026-08-10T12:00:00.000Z',
        total_traders: 2,
        top_trader_handle: 'handle-1',
        top_trader_roi: 19,
      },
    })
    expectPrivateNoStore(response)
  })

  it('accepts and forwards all 100 complete rows without truncating to 50', async () => {
    const traders = Array.from({ length: 100 }, (_value, index) => trader(index + 1))
    mockAbortSignal.mockResolvedValue({
      data: acknowledgement({
        snapshot: {
          ...acknowledgement().snapshot,
          total_traders: 100,
        },
      }),
      error: null,
    })

    const response = await POST(request(body({ traders })))

    expect(response.status).toBe(201)
    expect(mockRpc).toHaveBeenCalledWith(
      'create_ranking_snapshot_atomic',
      expect.objectContaining({ p_traders: traders })
    )
    expect((mockRpc.mock.calls[0]?.[1] as { p_traders: unknown[] }).p_traders).toHaveLength(100)
  })

  it('returns the same resource as a 200 replay receipt', async () => {
    mockAbortSignal.mockResolvedValue({
      data: acknowledgement({ status: 'replayed', applied: false }),
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      actor_id: ACTOR_ID,
      request_id: REQUEST_ID,
      status: 'replayed',
      applied: false,
      snapshot: { id: SNAPSHOT_ID, share_token: SHARE_TOKEN },
    })
  })

  it.each([
    ['another operation', { operation: 'share' }],
    ['a missing request nonce', { request_id: undefined }],
    ['an extra body field', { invented: true }],
    ['an empty trader set', { traders: [] }],
    ['101 traders', { traders: Array.from({ length: 101 }, (_value, index) => trader(index + 1)) }],
    ['a missing trader field', { traders: [{ ...trader(1), roi: undefined }] }],
    ['an extra trader field', { traders: [{ ...trader(1), invented: true }] }],
    ['a discontinuous rank', { traders: [trader(1), trader(3)] }],
  ])('rejects %s before invoking the authority', async (_label, override) => {
    const response = await POST(request(body(override)))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a declared oversized body before invoking authentication authority writes', async () => {
    const response = await POST(request('{}', { 'content-length': String(1024 * 1024 + 1) }))

    expect(response.status).toBe(413)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('binds created_by to the authenticated actor instead of accepting it in the body', async () => {
    const response = await POST(request(body({ created_by: ACTOR_ID })))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 400],
    ['account_inactive', 403],
    ['request_conflict', 409],
  ])('maps the exact %s status without a fallback write', async (status, expectedStatus) => {
    mockAbortSignal.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['another actor', { actor_id: '33333333-3333-4333-8333-333333333333' }],
    ['another request', { request_id: 'c'.repeat(32) }],
    [
      'another resource owner',
      {
        snapshot: {
          ...acknowledgement().snapshot,
          created_by: '33333333-3333-4333-8333-333333333333',
        },
      },
    ],
    ['a partial resource count', { snapshot: { ...acknowledgement().snapshot, total_traders: 1 } }],
    [
      'a mismatched top trader',
      {
        snapshot: {
          ...acknowledgement().snapshot,
          top_trader_handle: 'handle-2',
          top_trader_roi: 18,
        },
      },
    ],
    [
      'a mismatched expiry',
      {
        snapshot: {
          ...acknowledgement().snapshot,
          expires_at: '2026-08-11T12:00:00.000Z',
        },
      },
    ],
    ['an extra acknowledgement field', { invented: true }],
  ])('fails closed on %s acknowledgement', async (_label, override) => {
    mockAbortSignal.mockResolvedValue({ data: acknowledgement(override), error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it('returns a private 409 on changed-payload replay conflict', async () => {
    mockAbortSignal.mockResolvedValue({ data: { status: 'request_conflict' }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expectPrivateNoStore(response)
  })

  it('applies the private cache boundary to rate-limit responses', async () => {
    mockCheckRateLimit.mockResolvedValue(
      Response.json({ error: 'Too many requests' }, { status: 429 })
    )

    const response = await POST(request())

    expect(response.status).toBe(429)
    expectPrivateNoStore(response)
    expect(mockExtractUserFromRequest).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires authentication before reading the request body', async () => {
    mockExtractUserFromRequest.mockResolvedValue({ user: null, error: 'invalid token' })

    const response = await POST(request())

    expect(response.status).toBe(401)
    expectPrivateNoStore(response)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('maps a physical database deadline to a retryable response', async () => {
    mockAbortSignal.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    })

    const response = await POST(request())

    expect(response.status).toBe(503)
    expectPrivateNoStore(response)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns a private failure for a generic database error', async () => {
    mockAbortSignal.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'unexpected database error' },
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expectPrivateNoStore(response)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('maps an aborted 15-second authority call to a private retryable response', async () => {
    mockAbortSignal.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))

    const response = await POST(request())

    expect(response.status).toBe(503)
    expectPrivateNoStore(response)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns a private method error for GET', async () => {
    const response = await GET()

    expect(response.status).toBe(405)
    expectPrivateNoStore(response)
  })
})
