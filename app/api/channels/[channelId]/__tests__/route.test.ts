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
const mockFrom = jest.fn()
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

import { DELETE, PATCH } from '../route'

const actorId = '11111111-1111-4111-8111-111111111111'
const channelId = '22222222-2222-4222-8222-222222222222'

function context(id = channelId) {
  return { params: Promise.resolve({ channelId: id }) }
}

function rpcResult(data: unknown, error: { message: string } | null = null) {
  mockRpc.mockResolvedValue({ data, error })
}

function patchRequest(body: unknown, malformed = false) {
  return {
    json: malformed
      ? jest.fn().mockRejectedValue(new SyntaxError('invalid JSON'))
      : jest.fn().mockResolvedValue(body),
  } as never
}

const updatedChannel = {
  id: channelId,
  name: 'renamed',
  type: 'group',
  created_by: actorId,
  avatar_url: null,
  description: null,
  conversation_id: null,
  last_message_at: '2026-07-29T19:00:00.000Z',
  last_message_preview: null,
  created_at: '2026-07-28T19:00:00.000Z',
  updated_at: '2026-07-29T20:00:00.000Z',
}

function metadataAcknowledgement(
  overrides: Partial<{
    actor_id: unknown
    applied_fields: unknown
    changed: unknown
    channel: unknown
    success: unknown
  }> = {}
) {
  return {
    success: true,
    actor_id: actorId,
    applied_fields: ['name'],
    changed: true,
    channel: updatedChannel,
    ...overrides,
  }
}

describe('DELETE /api/channels/[channelId]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc, from: mockFrom })
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

describe('PATCH /api/channels/[channelId]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockFrom.mockImplementation(() => {
      throw new Error('PATCH must not issue direct table queries')
    })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc, from: mockFrom })
    rpcResult(metadataAcknowledgement())
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('normalizes the request and accepts the exact bound RPC acknowledgement', async () => {
    const avatarUrl = 'https://example.com/avatar.png'
    const channel = {
      ...updatedChannel,
      name: 'New name',
      avatar_url: avatarUrl,
      description: null,
    }
    rpcResult(
      metadataAcknowledgement({
        applied_fields: ['name', 'avatar_url', 'description'],
        channel,
      })
    )

    const response = await PATCH(
      patchRequest({
        name: '  New name  ',
        avatar_url: ' HTTPS://EXAMPLE.COM/avatar.png ',
        description: '   ',
      }),
      context(channelId.toUpperCase())
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ channel })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('update_group_channel_metadata_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_name: 'New name',
      p_name_present: true,
      p_avatar_url: avatarUrl,
      p_avatar_url_present: true,
      p_description: null,
      p_description_present: true,
    })
  })

  it('accepts an exact idempotent acknowledgement', async () => {
    rpcResult(metadataAcknowledgement({ changed: false }))

    const response = await PATCH(patchRequest({ name: 'renamed' }), context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ channel: updatedChannel })
  })

  it('requires authentication before request parsing or RPC execution', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await PATCH(patchRequest({ name: 'renamed' }), context())

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects an invalid channel id before request parsing or RPC execution', async () => {
    const response = await PATCH(patchRequest({ name: 'renamed' }), context('not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before the atomic RPC', async () => {
    const response = await PATCH(patchRequest(null, true), context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { name: '   ' },
    { name: 'valid', extra: true },
    { avatar_url: 'ftp://example.com/avatar.png' },
    { avatar_url: 'not a URL' },
    { description: 'x'.repeat(2_001) },
  ])('rejects invalid metadata input before the atomic RPC %#', async (body) => {
    const response = await PATCH(patchRequest(body), context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid channel update' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400, 'Invalid channel update'],
    ['ACTOR_UNAVAILABLE', 403, 'Account cannot update this channel'],
    ['CHANNEL_NOT_FOUND', 404, 'Channel not found'],
    ['CHANNEL_NOT_GROUP', 400, 'Channel does not support group settings'],
    ['PERMISSION_DENIED', 403, 'Permission denied'],
  ])('maps the exact %s denial without a fallback update', async (reason, status, error) => {
    rpcResult({ success: false, reason })

    const response = await PATCH(patchRequest({ name: 'renamed' }), context())

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic RPC errors', async () => {
    rpcResult(null, { message: 'serialization failure' })

    const response = await PATCH(patchRequest({ name: 'renamed' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith('Atomic group channel metadata update failed', {
      error: 'serialization failure',
    })
  })

  it.each([
    null,
    [],
    { success: false, reason: 'UNKNOWN' },
    { success: false, reason: 'PERMISSION_DENIED', extra: true },
    metadataAcknowledgement({ applied_fields: [] }),
    metadataAcknowledgement({ applied_fields: ['name', 'name'] }),
    metadataAcknowledgement({ applied_fields: ['description', 'name'] }),
    metadataAcknowledgement({ applied_fields: ['unknown'] }),
    metadataAcknowledgement({ actor_id: 'not-a-uuid' }),
    metadataAcknowledgement({ changed: 'yes' }),
    metadataAcknowledgement({ channel: null }),
    metadataAcknowledgement({ channel: { ...updatedChannel, extra: true } }),
    metadataAcknowledgement({ channel: { ...updatedChannel, type: 'direct' } }),
    metadataAcknowledgement({
      channel: { ...updatedChannel, updated_at: 'not-a-timestamp' },
    }),
    metadataAcknowledgement({
      channel: {
        ...updatedChannel,
        conversation_id: '33333333-3333-4333-8333-333333333333',
      },
    }),
  ])('rejects malformed or non-exact RPC acknowledgements %#', async (acknowledgement) => {
    rpcResult(acknowledgement)

    const response = await PATCH(patchRequest({ name: 'renamed' }), context())

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic group channel metadata update returned an invalid acknowledgement'
    )
  })

  it.each([
    metadataAcknowledgement({ actor_id: '33333333-3333-4333-8333-333333333333' }),
    metadataAcknowledgement({
      channel: { ...updatedChannel, id: '33333333-3333-4333-8333-333333333333' },
    }),
    metadataAcknowledgement({ applied_fields: ['description'] }),
    metadataAcknowledgement({ channel: { ...updatedChannel, name: 'wrong value' } }),
  ])(
    'rejects a well-shaped acknowledgement bound to the wrong request %#',
    async (acknowledgement) => {
      rpcResult(acknowledgement)

      const response = await PATCH(patchRequest({ name: 'renamed' }), context())

      expect(response.status).toBe(500)
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Atomic group channel metadata acknowledgement did not match its request'
      )
    }
  )
})
