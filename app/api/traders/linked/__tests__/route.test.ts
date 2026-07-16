const USER_ID = '11111111-1111-4111-8111-111111111111'
const LINK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockInvalidateLinkedTraderCache = jest.fn()
const mockRequireAuth = jest.fn().mockResolvedValue({ id: USER_ID })

jest.mock('@/lib/data/linked-traders', () => ({
  invalidateLinkedTraderCache: (...args: unknown[]) => mockInvalidateLinkedTraderCache(...args),
}))

jest.mock('@/lib/api', () => ({
  RateLimitPresets: { read: {}, sensitive: {}, write: {} },
  checkRateLimit: jest.fn().mockResolvedValue(null),
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
  handleError: (error: { message?: string; statusCode?: number }) => ({
    status: error?.statusCode || 500,
    async json() {
      return { success: false, error: error?.message || 'Internal error' }
    },
  }),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  success: (data: unknown) => ({
    status: 200,
    async json() {
      return { success: true, data }
    },
  }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import type { NextRequest } from 'next/server'
import { DELETE, PATCH } from '../route'

const mockInfo = jest.requireMock('@/lib/logger').logger.info as jest.Mock

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

describe('/api/traders/linked atomic mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
  })

  it('selects a primary through the ownership-validating RPC without table prewrites', async () => {
    const linkedTrader = { id: LINK_ID, user_id: USER_ID, is_primary: true }
    mockRpc.mockResolvedValue({ data: linkedTrader, error: null })

    const response = await PATCH(request({ id: LINK_ID, is_primary: true }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('set_primary_linked_trader', {
      p_link_id: LINK_ID,
      p_user_id: USER_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { linked_trader: linkedTrader },
    })
  })

  it('maps a foreign or missing primary target to not found with no fallback writes', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0002', message: 'linked trader not found' },
    })

    const response = await PATCH(request({ id: LINK_ID, is_primary: true }))

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateLinkedTraderCache).not.toHaveBeenCalled()
  })

  it('rejects directly unsetting the primary invariant', async () => {
    const response = await PATCH(request({ id: LINK_ID, is_primary: false }))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('allowlists and owner-scopes ordinary label updates', async () => {
    const result = Promise.resolve({
      data: { id: LINK_ID, user_id: USER_ID, label: 'Alpha' },
      error: null,
    })
    const builder: Record<string, jest.Mock> = {}
    builder.update = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.select = jest.fn(() => builder)
    builder.maybeSingle = jest.fn(() => result)
    mockFrom.mockReturnValue(builder)

    const response = await PATCH(request({ id: LINK_ID, label: '  Alpha  ' }))

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('user_linked_traders')
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Alpha', updated_at: expect.any(String) })
    )
    expect(builder.eq).toHaveBeenNthCalledWith(1, 'id', LINK_ID)
    expect(builder.eq).toHaveBeenNthCalledWith(2, 'user_id', USER_ID)
    expect(mockInvalidateLinkedTraderCache).toHaveBeenCalledWith(USER_ID)
  })

  it('unlinks only through the atomic service RPC', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          promoted_link_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          remaining_count: 0,
          removed_source: 'binance',
          removed_trader_id: 'trader-a',
        },
      ],
      error: null,
    })

    const response = await DELETE(request({ id: LINK_ID }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('unlink_linked_trader', {
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
        remaining_count: 0,
      },
    })
  })
})
