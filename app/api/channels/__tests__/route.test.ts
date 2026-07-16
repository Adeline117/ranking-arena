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
const mockRandomUUID = jest.fn()

jest.mock('node:crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}))
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

import { POST } from '../route'

const actorId = '11111111-1111-4111-8111-111111111111'
const memberId = '22222222-2222-4222-8222-222222222222'
const blockedId = '33333333-3333-4333-8333-333333333333'
const channelId = '44444444-4444-4444-8444-444444444444'

const channel = {
  id: channelId,
  name: 'Safe group',
  type: 'group',
  created_by: actorId,
  avatar_url: null,
  description: 'reviewed',
  conversation_id: null,
  last_message_at: '2026-07-16T16:10:00.000Z',
  last_message_preview: null,
  created_at: '2026-07-16T16:10:00.000Z',
  updated_at: '2026-07-16T16:10:00.000Z',
}
const members = [
  { user_id: actorId, role: 'owner' },
  { user_id: memberId, role: 'member' },
]

function request(body: unknown, malformed = false) {
  return {
    json: jest.fn(
      malformed ? () => Promise.reject(new Error('invalid json')) : () => Promise.resolve(body)
    ),
  }
}

function rpcResult(data: unknown, error: { message: string } | null = null) {
  mockRpc.mockResolvedValue({ data, error })
}

describe('POST /api/channels', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: actorId })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc })
    mockRandomUUID.mockReturnValue(channelId)
    rpcResult({ success: true, channel, member_count: 2, members })
  })

  it.each([
    [{ name: '', memberIds: [memberId] }],
    [{ name: 'Group', memberIds: [] }],
    [{ name: 'Group', memberIds: ['not-a-uuid'] }],
    [{ channelId: 'not-a-uuid', name: 'Group', memberIds: [memberId] }],
    [{ name: 'Group', memberIds: [memberId], created_by: actorId }],
    [
      {
        name: 'Group',
        memberIds: Array.from(
          { length: 50 },
          (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
        ),
      },
    ],
  ])('rejects invalid or authority-bearing input before the RPC %#', async (body) => {
    const response = await POST(request(body) as never)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before the RPC', async () => {
    const response = await POST(request({}, true) as never)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('accepts actor plus 49 raw IDs as a complete 50-person roster boundary', async () => {
    const candidates = Array.from(
      { length: 49 },
      (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
    )
    rpcResult({ success: false, reason: 'PRIVACY_DENIED' })

    const response = await POST(
      request({ name: 'Boundary group', memberIds: [actorId, ...candidates] }) as never
    )

    expect(response.status).toBe(400)
    expect(mockRpc).toHaveBeenCalledWith(
      'create_group_channel_atomic',
      expect.objectContaining({ p_candidate_ids: candidates })
    )
  })

  it('normalizes and deduplicates members before one atomic RPC', async () => {
    const response = await POST(
      request({
        name: '  Safe group  ',
        description: '  reviewed  ',
        memberIds: [actorId, memberId.toUpperCase(), memberId],
      }) as never
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ channel })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('create_group_channel_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_name: 'Safe group',
      p_description: 'reviewed',
      p_candidate_ids: [memberId],
    })
  })

  it('preserves a caller-provided canonical channel id for idempotent retry', async () => {
    const response = await POST(
      request({
        channelId: channelId.toUpperCase(),
        name: 'Safe group',
        description: 'reviewed',
        memberIds: [memberId],
      }) as never
    )

    expect(response.status).toBe(200)
    expect(mockRandomUUID).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'create_group_channel_atomic',
      expect.objectContaining({ p_channel_id: channelId })
    )
  })

  it('sends an absent or blank description as canonical null', async () => {
    const channelWithoutDescription = { ...channel, description: null }
    rpcResult({
      success: true,
      channel: channelWithoutDescription,
      member_count: 2,
      members,
    })

    const response = await POST(
      request({ name: 'Safe group', description: '   ', memberIds: [memberId] }) as never
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'create_group_channel_atomic',
      expect.objectContaining({ p_description: null })
    )
  })

  it('fails closed when the atomic RPC errors', async () => {
    rpcResult(null, { message: 'transaction failed' })

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith('Atomic group channel creation failed', {
      error: 'transaction failed',
    })
  })

  it.each([
    ['ACTOR_UNAVAILABLE', 403, 'Account cannot create a group chat'],
    ['CANDIDATE_UNAVAILABLE', 400, 'One or more selected members cannot be added'],
    ['PRIVACY_DENIED', 400, 'One or more selected members cannot be added'],
    ['CHANNEL_ID_CONFLICT', 500, 'Failed to create group chat'],
  ])('maps the exact %s denial without a fallback write', async (reason, status, error) => {
    rpcResult({ success: false, reason })

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('returns 409 when a caller-provided intent id conflicts with a different payload', async () => {
    rpcResult({ success: false, reason: 'CHANNEL_ID_CONFLICT' })

    const response = await POST(
      request({ channelId, name: 'Group', memberIds: [memberId] }) as never
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Group creation intent changed' })
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic group channel creation rejected a reused intent id'
    )
  })

  it('keeps a server-generated UUID collision as an internal failure', async () => {
    rpcResult({ success: false, reason: 'CHANNEL_ID_CONFLICT' })

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic group channel creation rejected a generated channel id collision'
    )
  })

  it.each([
    [null],
    [[]],
    [{ success: true, channel, member_count: 2, members, extra: true }],
    [{ success: false, reason: 'UNKNOWN' }],
    [{ success: false, reason: 'PRIVACY_DENIED', extra: true }],
    [
      {
        success: true,
        channel: { ...channel, unexpected: true },
        member_count: 2,
        members,
      },
    ],
    [{ success: true, channel: { ...channel, type: 'direct' }, member_count: 2, members }],
    [
      {
        success: true,
        channel: { ...channel, created_at: 'not-a-date' },
        member_count: 2,
        members,
      },
    ],
    [{ success: true, channel, member_count: 1, members }],
    [{ success: true, channel, member_count: 2, members: [...members].reverse() }],
    [
      {
        success: true,
        channel,
        member_count: 2,
        members: [
          { user_id: actorId, role: 'owner' },
          { user_id: actorId, role: 'member' },
        ],
      },
    ],
  ])('rejects malformed or non-exact acknowledgements %#', async (acknowledgement) => {
    rpcResult(acknowledgement)

    const response = await POST(request({ name: 'Group', memberIds: [memberId] }) as never)

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic group channel creation returned an invalid acknowledgement'
    )
  })

  it.each([
    [{ ...channel, id: blockedId }, 2],
    [{ ...channel, created_by: blockedId }, 2],
    [{ ...channel, name: 'Different' }, 2],
    [{ ...channel, description: null }, 2],
  ])(
    'rejects a validly shaped acknowledgement that does not match the request %#',
    async (returnedChannel, memberCount) => {
      rpcResult({ success: true, channel: returnedChannel, member_count: memberCount, members })

      const response = await POST(
        request({ name: 'Safe group', description: 'reviewed', memberIds: [memberId] }) as never
      )

      expect(response.status).toBe(500)
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Atomic group channel creation acknowledgement did not match its request'
      )
    }
  )

  it('rejects a same-count acknowledgement with the wrong roster identity or role', async () => {
    rpcResult({
      success: true,
      channel,
      member_count: 2,
      members: [
        { user_id: actorId, role: 'member' },
        { user_id: blockedId, role: 'owner' },
      ],
    })

    const response = await POST(
      request({ name: 'Safe group', description: 'reviewed', memberIds: [memberId] }) as never
    )

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Atomic group channel creation acknowledgement returned the wrong roster'
    )
  })
})
