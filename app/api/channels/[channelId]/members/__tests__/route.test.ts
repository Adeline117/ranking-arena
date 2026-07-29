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
const mockFrom = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { DELETE, PATCH, POST } from '../route'

const actorId = '11111111-1111-4111-8111-111111111111'
const channelId = '22222222-2222-4222-8222-222222222222'
const existingAdminId = '33333333-3333-4333-8333-333333333333'
const newMemberId = '44444444-4444-4444-8444-444444444444'

function mutationAcknowledgement({
  action,
  targetId = newMemberId,
  role = null,
  changed = true,
}: {
  action: 'leave' | 'remove' | 'set_role'
  targetId?: string
  role?: 'admin' | 'member' | null
  changed?: boolean
}) {
  return {
    success: true,
    channel_id: channelId,
    actor_id: actorId,
    target_id: targetId,
    action,
    changed,
    role,
  }
}

function request(body: unknown, malformed = false) {
  return {
    json: jest.fn(
      malformed ? () => Promise.reject(new Error('invalid json')) : () => Promise.resolve(body)
    ),
  }
}

function context(id = channelId) {
  return { params: Promise.resolve({ channelId: id }) }
}

describe('channel member write boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom, rpc: mockRpc })
  })

  it.each([
    ['bad-channel', { userIds: [newMemberId] }],
    [channelId, { userIds: [] }],
    [channelId, { userIds: ['not-a-uuid'] }],
    [channelId, { userIds: [newMemberId], role: 'owner' }],
  ])('rejects malformed add-member authority before database access %#', async (id, body) => {
    const response = await POST(request(body) as never, context(id))

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before database access', async () => {
    const response = await POST(request({}, true) as never, context())

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic RPC fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('passes only normalized distinct non-actor candidates to the atomic RPC', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, channel_id: channelId, added: 2 },
      error: null,
    })

    const response = await POST(
      request({ userIds: [actorId, existingAdminId, newMemberId, existingAdminId] }) as never,
      context()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, added: 2 })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('add_channel_members_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_candidate_ids: [existingAdminId, newMemberId],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['CHANNEL_NOT_FOUND', 404],
    ['CHANNEL_NOT_GROUP', 400],
    ['PERMISSION_DENIED', 403],
    ['CAPACITY_EXCEEDED', 400],
    ['CANDIDATE_UNAVAILABLE', 400],
    ['PRIVACY_DENIED', 400],
  ])('maps the exact atomic denial %s without a fallback write', async (reason, status) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    { success: true, channel_id: channelId, added: 1, extra: true },
    { success: true, channel_id: 'not-a-uuid', added: 1 },
    { success: true, channel_id: channelId, added: -1 },
    { success: true, channel_id: channelId, added: 1.5 },
    { success: false, reason: 'UNKNOWN' },
    { success: false, reason: 'PRIVACY_DENIED', extra: true },
  ])('fails closed on a malformed atomic acknowledgement %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { success: true, channel_id: existingAdminId, added: 1 },
    { success: true, channel_id: channelId, added: 2 },
  ])('rejects a valid-shaped acknowledgement that does not match the request %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request({ userIds: [newMemberId] }) as never, context())

    expect(response.status).toBe(500)
  })

  it('accepts an exact idempotent acknowledgement without a client-side rewrite', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, channel_id: channelId, added: 0 },
      error: null,
    })

    const response = await POST(request({ userIds: [existingAdminId] }) as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, added: 0 })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects a self-targeted role change before database access', async () => {
    const response = await PATCH(request({ userId: actorId, role: 'member' }) as never, context())

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [DELETE, request({ userId: 'not-a-uuid' }), context()],
    [DELETE, request({}, true), context()],
    [DELETE, request({ userId: newMemberId }), context('bad-channel')],
    [PATCH, request({ userId: newMemberId, role: 'owner' }), context()],
    [PATCH, request({}, true), context()],
    [PATCH, request({ userId: newMemberId, role: 'admin' }), context('bad-channel')],
  ])('rejects malformed remove/role input before database access %#', async (handler, req, ctx) => {
    const response = await handler(req as never, ctx)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['remove', newMemberId, 'removed'],
    ['leave', actorId, 'left'],
  ] as const)(
    'uses one exact atomic %s RPC and never falls back to a table mutation',
    async (action, targetId, responseAction) => {
      mockRpc.mockResolvedValue({
        data: mutationAcknowledgement({ action, targetId }),
        error: null,
      })

      const response = await DELETE(request({ userId: targetId }) as never, context())

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true, action: responseAction })
      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockRpc).toHaveBeenCalledWith('mutate_channel_member_atomic', {
        p_channel_id: channelId,
        p_actor_id: actorId,
        p_target_id: targetId,
        p_action: action,
        p_role: null,
      })
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('uses one exact atomic role RPC and accepts a same-role acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: mutationAcknowledgement({ action: 'set_role', role: 'admin', changed: false }),
      error: null,
    })

    const response = await PATCH(
      request({ userId: newMemberId, role: 'admin' }) as never,
      context()
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('mutate_channel_member_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_target_id: newMemberId,
      p_action: 'set_role',
      p_role: 'admin',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([DELETE, PATCH])('fails %p closed when the atomic RPC fails', async (handler) => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })
    const body =
      handler === DELETE ? { userId: newMemberId } : { userId: newMemberId, role: 'admin' as const }

    const response = await handler(request(body) as never, context())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['CHANNEL_NOT_FOUND', 404],
    ['CHANNEL_NOT_GROUP', 400],
    ['MEMBERSHIP_NOT_FOUND', 404],
    ['OWNER_FORBIDDEN', 400],
    ['PEER_ADMIN_FORBIDDEN', 403],
    ['ACTOR_UNAVAILABLE', 403],
    ['PERMISSION_DENIED', 403],
  ])('maps remove denial %s to %i without fallback writes', async (reason, status) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await DELETE(request({ userId: newMemberId }) as never, context())

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['CHANNEL_NOT_FOUND', 404],
    ['CHANNEL_NOT_GROUP', 400],
    ['MEMBERSHIP_NOT_FOUND', 404],
    ['OWNER_FORBIDDEN', 400],
    ['PEER_ADMIN_FORBIDDEN', 403],
    ['ACTOR_UNAVAILABLE', 403],
    ['PERMISSION_DENIED', 403],
  ])('maps role-change denial %s to %i without fallback writes', async (reason, status) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await PATCH(
      request({ userId: newMemberId, role: 'admin' }) as never,
      context()
    )

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    { success: false, reason: 'UNKNOWN' },
    { success: false, reason: 'PERMISSION_DENIED', extra: true },
    { ...mutationAcknowledgement({ action: 'remove' }), extra: true },
    { ...mutationAcknowledgement({ action: 'remove' }), channel_id: 'not-a-uuid' },
    { ...mutationAcknowledgement({ action: 'remove' }), action: 'unknown' },
    { ...mutationAcknowledgement({ action: 'remove' }), changed: false },
    { ...mutationAcknowledgement({ action: 'remove' }), role: 'member' },
  ])('fails removal closed on malformed atomic evidence %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await DELETE(request({ userId: newMemberId }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { ...mutationAcknowledgement({ action: 'remove' }), channel_id: existingAdminId },
    { ...mutationAcknowledgement({ action: 'remove' }), actor_id: existingAdminId },
    { ...mutationAcknowledgement({ action: 'remove' }), target_id: existingAdminId },
    { ...mutationAcknowledgement({ action: 'remove' }), action: 'leave' },
  ])('rejects valid-shaped removal evidence for the wrong resource %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await DELETE(request({ userId: newMemberId }) as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    {
      ...mutationAcknowledgement({ action: 'set_role', role: 'admin' }),
      channel_id: existingAdminId,
    },
    {
      ...mutationAcknowledgement({ action: 'set_role', role: 'admin' }),
      actor_id: existingAdminId,
    },
    {
      ...mutationAcknowledgement({ action: 'set_role', role: 'admin' }),
      target_id: existingAdminId,
    },
    {
      ...mutationAcknowledgement({ action: 'set_role', role: 'admin' }),
      action: 'remove',
      role: null,
    },
    { ...mutationAcknowledgement({ action: 'set_role', role: 'member' }) },
  ])('rejects role evidence that does not match the requested resource %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await PATCH(
      request({ userId: newMemberId, role: 'admin' }) as never,
      context()
    )

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
