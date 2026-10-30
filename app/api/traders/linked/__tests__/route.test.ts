const USER_ID = '11111111-1111-4111-8111-111111111111'
const LINK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockInvalidateLinkedTraderCache = jest.fn()
const mockRequireAuth = jest.fn().mockResolvedValue({ id: USER_ID })

jest.mock('@/lib/data/linked-traders', () => ({
  invalidateLinkedTraderCache: (...args: unknown[]) => mockInvalidateLinkedTraderCache(...args),
}))

jest.mock('@/lib/api', () => {
  const createHeaders = () => {
    const values = new Map<string, string>()
    return {
      get: (name: string) => values.get(name.toLowerCase()) ?? null,
      set: (name: string, value: string) => values.set(name.toLowerCase(), value),
    }
  }
  return {
    RateLimitPresets: { read: {}, sensitive: {}, write: {} },
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
    handleError: (error: { message?: string; statusCode?: number }) => ({
      status: error?.statusCode || 500,
      headers: createHeaders(),
      async json() {
        return { success: false, error: error?.message || 'Internal error' }
      },
    }),
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    success: (data: unknown) => ({
      status: 200,
      headers: createHeaders(),
      async json() {
        return { success: true, data }
      },
    }),
  }
})

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import type { NextRequest } from 'next/server'
import { DELETE, GET, PATCH } from '../route'

const mockInfo = jest.requireMock('@/lib/logger').logger.info as jest.Mock

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

function mockSingleRpcResult(result: {
  data: Record<string, unknown> | null
  error: { code?: string; message?: string } | null
}) {
  const single = jest.fn().mockResolvedValue(result)
  mockRpc.mockReturnValue({ single })
  return single
}

function responseHeaders() {
  const values = new Map<string, string>()
  return {
    get: (name: string) => values.get(name.toLowerCase()) ?? null,
    set: (name: string, value: string) => values.set(name.toLowerCase(), value),
  }
}

function expectPrivateNoStore(response: { headers: { get(name: string): string | null } }) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Pragma')).toBe('no-cache')
}

describe('/api/traders/linked atomic mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
    mockCheckRateLimit.mockResolvedValue(null)
  })

  it('returns exact membership without publishing unbound leaderboard numerics', async () => {
    const linkedTrader = {
      id: LINK_ID,
      user_id: USER_ID,
      trader_id: 'exact-account-id',
      source: 'binance_futures',
      label: null,
      is_primary: true,
      display_order: 0,
      verified_at: '2026-07-29T00:00:00.000Z',
      verification_method: 'api_key',
      created_at: '2026-07-29T00:00:00.000Z',
      updated_at: '2026-07-29T00:00:00.000Z',
    }
    const result = Promise.resolve({ data: [linkedTrader], error: null })
    const builder: Record<string, jest.Mock> = {}
    builder.select = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.order = jest.fn(() => result)
    mockFrom.mockReturnValue(builder)

    const response = await GET({} as NextRequest)

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('user_linked_traders')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        count: 1,
        linked_traders: [
          {
            id: LINK_ID,
            user_id: USER_ID,
            trader_id: 'exact-account-id',
            source: 'binance_futures',
            label: null,
            is_primary: true,
            verified_at: '2026-07-29T00:00:00.000Z',
            verification_method: 'api_key',
            stats: null,
          },
        ],
      },
    })
  })

  it('keeps empty membership, rate limits, and read failures private and uncacheable', async () => {
    const emptyBuilder: Record<string, jest.Mock> = {}
    emptyBuilder.select = jest.fn(() => emptyBuilder)
    emptyBuilder.eq = jest.fn(() => emptyBuilder)
    emptyBuilder.order = jest.fn().mockResolvedValue({ data: [], error: null })
    mockFrom.mockReturnValueOnce(emptyBuilder)

    const emptyResponse = await GET({} as NextRequest)
    expectPrivateNoStore(emptyResponse)
    await expect(emptyResponse.json()).resolves.toMatchObject({
      data: { linked_traders: [], count: 0 },
    })

    const rateLimitResponse = {
      status: 429,
      headers: responseHeaders(),
      async json() {
        return { success: false, error: 'rate limited' }
      },
    }
    mockCheckRateLimit.mockResolvedValueOnce(rateLimitResponse)
    const limitedResponse = await GET({} as NextRequest)
    expectPrivateNoStore(limitedResponse)
    expect(mockFrom).toHaveBeenCalledTimes(1)

    const errorBuilder: Record<string, jest.Mock> = {}
    errorBuilder.select = jest.fn(() => errorBuilder)
    errorBuilder.eq = jest.fn(() => errorBuilder)
    errorBuilder.order = jest.fn().mockResolvedValue({ data: null, error: new Error('db failed') })
    mockFrom.mockReturnValueOnce(errorBuilder)
    const errorResponse = await GET({} as NextRequest)
    expectPrivateNoStore(errorResponse)
    expect(errorResponse.status).toBe(500)
  })

  it('selects a primary through the ownership-validating RPC without table prewrites', async () => {
    const linkedTrader = { id: LINK_ID, user_id: USER_ID, is_primary: true }
    const single = mockSingleRpcResult({ data: linkedTrader, error: null })

    const response = await PATCH(request({ id: LINK_ID, is_primary: true }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('set_primary_linked_trader_v2', {
      p_link_id: LINK_ID,
      p_user_id: USER_ID,
    })
    expect(single).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { linked_trader: linkedTrader },
    })
  })

  it('maps a foreign or missing primary target to not found with no fallback writes', async () => {
    const single = mockSingleRpcResult({
      data: null,
      error: { code: 'P0002', message: 'linked trader not found' },
    })

    const response = await PATCH(request({ id: LINK_ID, is_primary: true }))

    expect(response.status).toBe(404)
    expect(single).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).not.toHaveBeenCalled()
  })

  it('rejects directly unsetting the primary invariant', async () => {
    const response = await PATCH(request({ id: LINK_ID, is_primary: false }))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('allowlists and owner-scopes ordinary label updates through the metadata RPC', async () => {
    const single = mockSingleRpcResult({
      data: { id: LINK_ID, user_id: USER_ID, label: 'Alpha' },
      error: null,
    })

    const response = await PATCH(request({ id: LINK_ID, label: '  Alpha  ' }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('update_linked_trader_metadata_v1', {
      p_user_id: USER_ID,
      p_link_id: LINK_ID,
      p_update_label: true,
      p_label: 'Alpha',
      p_update_display_order: false,
      p_display_order: null,
    })
    expect(single).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
  })

  it('distinguishes an omitted label from an explicit clear', async () => {
    const single = mockSingleRpcResult({
      data: { id: LINK_ID, user_id: USER_ID },
      error: null,
    })

    await PATCH(request({ id: LINK_ID, display_order: 7 }))
    expect(mockRpc).toHaveBeenLastCalledWith('update_linked_trader_metadata_v1', {
      p_user_id: USER_ID,
      p_link_id: LINK_ID,
      p_update_label: false,
      p_label: null,
      p_update_display_order: true,
      p_display_order: 7,
    })

    await PATCH(request({ id: LINK_ID, label: null }))
    expect(mockRpc).toHaveBeenLastCalledWith('update_linked_trader_metadata_v1', {
      p_user_id: USER_ID,
      p_link_id: LINK_ID,
      p_update_label: true,
      p_label: null,
      p_update_display_order: false,
      p_display_order: null,
    })
    expect(single).toHaveBeenCalledTimes(2)
  })

  it('unlinks only through the atomic service RPC', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          promoted_link_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          remaining_count: 2,
          removed_source: 'binance',
          removed_trader_id: 'trader-a',
        },
      ],
      error: null,
    })

    const response = await DELETE(request({ id: LINK_ID }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('unlink_linked_trader_v2', {
      p_link_id: LINK_ID,
      p_user_id: USER_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
    expect(mockInfo).toHaveBeenCalledWith(
      '[linked-traders] Unlinked trader',
      expect.objectContaining({ userId: USER_ID, traderId: 'trader-a' })
    )
    await expect(response.json()).resolves.toMatchObject({
      data: {
        promoted_link_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        remaining_count: 2,
      },
    })
  })
})
