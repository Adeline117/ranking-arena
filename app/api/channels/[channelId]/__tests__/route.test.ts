jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown
    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
    async json() {
      return this.body
    }
  }
  return { NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockRpc = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}))

import { DELETE } from '../route'

const actorId = '11111111-1111-4111-8111-111111111111'
const channelId = '22222222-2222-4222-8222-222222222222'

function context(id = channelId) {
  return { params: Promise.resolve({ channelId: id }) }
}

function rpcResult(data: unknown, error: { message: string } | null = null) {
  mockRpc.mockResolvedValue({ data, error })
}

describe('DELETE /api/channels/[channelId]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc })
    rpcResult({
      success: true,
      channel_id: channelId,
      applied: true,
      deleted: 1,
    })
  })

  it('rejects an invalid channel id before the atomic RPC', async () => {
    const response = await DELETE({} as never, context('not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires authentication before the atomic RPC', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await DELETE({} as never, context())

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    [{ success: true, channel_id: channelId, applied: true, deleted: 1 }],
    [{ success: true, channel_id: channelId, applied: false, deleted: 0 }],
  ])('accepts exact applied and idempotent-missing acknowledgements %#', async (ack) => {
    rpcResult(ack)

    const response = await DELETE({} as never, context(channelId.toUpperCase()))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('dissolve_group_channel_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
    })
  })

  it.each([
    ['PERMISSION_DENIED', 403, 'Only owner can dissolve'],
    ['CHANNEL_NOT_GROUP', 400, 'Channel cannot be dissolved'],
  ])('maps the exact %s denial without a fallback delete', async (reason, status, error) => {
    rpcResult({ success: false, channel_id: channelId, reason })

    const response = await DELETE({} as never, context())

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic RPC errors', async () => {
    rpcResult(null, { message: 'serialization failure' })

    const response = await DELETE({} as never, context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith('Atomic group channel dissolution failed', {
      error: 'serialization failure',
    })
  })

  it.each([
    [null],
    [[]],
    [{ success: true, channel_id: channelId, applied: true, deleted: 0 }],
    [{ success: true, channel_id: channelId, applied: false, deleted: 1 }],
    [{ success: true, channel_id: channelId, applied: true, deleted: 1, extra: true }],
    [{ success: false, channel_id: channelId, reason: 'UNKNOWN' }],
    [{ success: false, channel_id: channelId, reason: 'PERMISSION_DENIED', extra: true }],
    [
      {
        success: true,
        channel_id: '33333333-3333-4333-8333-333333333333',
        applied: true,
        deleted: 1,
      },
    ],
  ])('rejects malformed, non-exact or mismatched acknowledgements %#', async (ack) => {
    rpcResult(ack)

    const response = await DELETE({} as never, context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic group channel dissolution returned an invalid acknowledgement'
    )
  })
})
