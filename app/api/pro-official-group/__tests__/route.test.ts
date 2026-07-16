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

const mockVerifyAuth = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockMaybeSingle = jest.fn()
const mockSendNotification = jest.fn()
const mockSocialFeatureGuard = jest.fn()
const mockCheckRateLimit = jest.fn()

jest.mock('@/lib/api/auth', () => ({
  verifyAuth: (...args: unknown[]) => mockVerifyAuth(...args),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/features', () => ({
  socialFeatureGuard: () => mockSocialFeatureGuard(),
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: {} },
}))

import { DELETE, GET, POST, joinProOfficialGroup, leaveProOfficialGroup } from '../route'

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const proGroupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const groupId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const joinedAt = '2026-07-16T20:00:00.000Z'

function request() {
  return {} as never
}

function joinedAcknowledgement(status: 'joined' | 'already_member' = 'joined') {
  return {
    status,
    pro_group_id: proGroupId,
    group_id: groupId,
    group_number: 2,
    official_member_count: 2,
    registry_member_count: 2,
    group_member_count: 3,
  }
}

function leftAcknowledgement() {
  return {
    status: 'left',
    pro_group_id: proGroupId,
    group_id: groupId,
    official_member_count: 1,
    registry_member_count: 1,
    group_member_count: 2,
  }
}

describe('Pro official-group atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockVerifyAuth.mockResolvedValue({ user: { id: actorId }, tier: 'free' })
    mockSocialFeatureGuard.mockReturnValue(null)
    mockCheckRateLimit.mockResolvedValue(null)
    mockMaybeSingle.mockResolvedValue({ data: { id: ownerId }, error: null })
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle })
    mockSelect.mockReturnValue({ eq: mockEq })
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'user_profiles') throw new Error(`Unexpected direct table access: ${table}`)
      return { select: mockSelect }
    })
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc, from: mockFrom })
  })

  it('maps an exact GET acknowledgement without reading either registry table', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'found',
        pro_group_id: proGroupId,
        group_id: groupId,
        group_number: 2,
        current_member_count: 499,
        is_active: true,
        joined_at: joinedAt,
      },
      error: null,
    })

    const response = await GET(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        group_id: groupId,
        group_number: 2,
        current_member_count: 499,
        is_active: true,
        joined_at: joinedAt,
      },
    })
    expect(mockRpc).toHaveBeenCalledWith('get_pro_official_group_atomic', {
      p_actor_id: actorId,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses current database entitlement instead of the cached auth tier', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_member' }, error: null })

    const response = await GET(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, data: null })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('maps the database Pro denial to the existing GET response', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'pro_required' }, error: null })

    const response = await GET(request())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'Pro membership required',
      code: 'PRO_REQUIRED',
    })
  })

  it.each([
    null,
    [],
    { status: 'found', group_id: groupId },
    {
      status: 'found',
      pro_group_id: proGroupId,
      group_id: groupId,
      group_number: 2,
      current_member_count: 501,
      is_active: true,
      joined_at: joinedAt,
    },
    { status: 'not_member', extra: true },
  ])('fails closed on a malformed GET acknowledgement %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await GET(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch group info' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('joins through one atomic RPC and sends a welcome only after joined evidence', async () => {
    mockRpc.mockResolvedValue({ data: joinedAcknowledgement('joined'), error: null })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Joined Pro official group',
      group_id: groupId,
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('join_pro_official_group_atomic', {
      p_actor_id: actorId,
      p_owner_id: ownerId,
    })
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
  })

  it('accepts an exact already-member replay without a duplicate welcome', async () => {
    mockRpc.mockResolvedValue({ data: joinedAcknowledgement('already_member'), error: null })

    const result = await joinProOfficialGroup(actorId.toUpperCase())

    expect(result).toEqual({ success: true, message: 'already_member', groupId })
    expect(mockRpc).toHaveBeenCalledWith('join_pro_official_group_atomic', {
      p_actor_id: actorId,
      p_owner_id: ownerId,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('maps the RPC Pro denial to the existing POST response', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'pro_required' }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'Pro membership required',
      code: 'PRO_REQUIRED',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    { ...joinedAcknowledgement(), extra: true },
    { ...joinedAcknowledgement(), registry_member_count: 1 },
    { ...joinedAcknowledgement(), group_member_count: 2 },
    { ...joinedAcknowledgement(), group_id: 'not-a-uuid' },
    { status: 'UNKNOWN' },
  ])('rejects malformed join evidence without a notification %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('does not call the write RPC when the configured owner lookup fails closed', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { code: 'DB_DOWN' } })

    const response = await POST(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'server_error' })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    [leftAcknowledgement(), true, 'Left Pro official group'],
    [{ status: 'not_member' }, false, 'You are not in the Pro official group'],
  ])('maps the exact leave acknowledgement %#', async (data, expected, message) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const helperResult = await leaveProOfficialGroup(actorId)
    expect(helperResult).toBe(expected)

    mockRpc.mockClear()
    mockRpc.mockResolvedValue({ data, error: null })
    const response = await DELETE(request())
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, message })
    expect(mockRpc).toHaveBeenCalledWith('leave_pro_official_group_atomic', {
      p_actor_id: actorId,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [null, null],
    [{ status: 'left', group_id: groupId }, null],
    [{ ...leftAcknowledgement(), official_member_count: 2 }, null],
    [{ status: 'not_member', extra: true }, null],
    [null, { code: 'DB_DOWN' }],
  ])('fails DELETE closed on RPC error or malformed evidence %#', async (data, error) => {
    mockRpc.mockResolvedValue({ data, error })

    const response = await DELETE(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Server error' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects an invalid webhook actor before any database access', async () => {
    await expect(leaveProOfficialGroup('not-a-uuid')).rejects.toThrow(
      'invalid_official_group_actor'
    )
    await expect(joinProOfficialGroup('not-a-uuid')).resolves.toEqual({
      success: false,
      message: 'invalid',
    })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
