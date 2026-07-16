import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockSendNotification = jest.fn()
const mockLogError = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { url: string; json: () => Promise<unknown> }
      }) => unknown
    ) =>
    async (request: { url: string; json: () => Promise<unknown> }) =>
      handler({
        user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        request,
      }),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLogError(...args) },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))
jest.mock('@/lib/types/premium', () => ({ PRO_FREE_PROMO: true }))

import { POST } from '../route'
import { generateInviteToken, hashInviteToken } from '@/lib/groups/invite-tokens'

const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REQUEST_ID = '30000000-0000-4000-8000-000000000003'

function request(body: unknown, groupId = GROUP_ID) {
  return {
    url: `http://localhost/api/groups/${groupId}/membership`,
    json: jest.fn().mockResolvedValue(body),
  }
}

describe('POST atomic group membership', () => {
  beforeAll(() => {
    process.env.INVITE_SECRET = 'membership-test-invite-secret-with-more-than-thirty-two-characters'
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('joins through the atomic RPC and notifies only after committed success', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'joined', owner_id: OWNER_ID, member_count: 8 },
      error: null,
    })

    const response = await POST(request({ action: 'join' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'joined',
      member_count: 8,
    })
    expect(mockRpc).toHaveBeenCalledWith('mutate_group_membership_atomic', {
      p_actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      p_group_id: GROUP_ID,
      p_action: 'join',
      p_pro_free_promo: true,
    })
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
  })

  it('treats an already-existing membership as idempotent without notifying', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'already_member', role: 'member', member_count: 8 },
      error: null,
    })

    const response = await POST(request({ action: 'join' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'already_member',
      role: 'member',
      member_count: 8,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('leaves idempotently through the atomic RPC', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'left', member_count: 7 }, error: null })
      .mockResolvedValueOnce({ data: { status: 'not_member' }, error: null })

    const left = await POST(request({ action: 'leave' }) as never)
    const repeated = await POST(request({ action: 'leave' }) as never)

    expect(left.status).toBe(200)
    await expect(left.json()).resolves.toEqual({
      success: true,
      action: 'left',
      member_count: 7,
    })
    await expect(repeated.json()).resolves.toEqual({ success: true, action: 'not_member' })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('redeems a bound signed invite through the atomic RPC', async () => {
    const inviteToken = generateInviteToken(GROUP_ID, Date.now() + 60_000)
    mockRpc.mockResolvedValue({
      data: { status: 'joined', owner_id: OWNER_ID, member_count: 8 },
      error: null,
    })

    const response = await POST(request({ action: 'join', invite_token: inviteToken }) as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('redeem_group_invite_atomic', {
      p_actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      p_group_id: GROUP_ID,
      p_token_hash: hashInviteToken(inviteToken),
      p_pro_free_promo: true,
    })
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid or cross-group invite before calling the database', async () => {
    const otherGroupToken = generateInviteToken(
      '20000000-0000-4000-8000-000000000002',
      Date.now() + 60_000
    )

    const malformed = await POST(request({ action: 'join', invite_token: 'not-a-token' }) as never)
    const crossGroup = await POST(
      request({ action: 'join', invite_token: otherGroupToken }) as never
    )

    expect(malformed.status).toBe(400)
    expect(crossGroup.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('creates a pending request when the database requires approval', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'approval_required' }, error: null })
      .mockResolvedValueOnce({
        data: { status: 'requested', request_id: REQUEST_ID },
        error: null,
      })

    const response = await POST(
      request({ action: 'join', answer_text: 'I trade options responsibly.' }) as never
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'requested',
      request_id: REQUEST_ID,
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'mutate_group_join_request_atomic', {
      p_actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      p_group_id: GROUP_ID,
      p_action: 'request',
      p_answer_text: 'I trade options responsibly.',
      p_pro_free_promo: true,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns the existing pending request without inventing another', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'approval_required' }, error: null })
      .mockResolvedValueOnce({
        data: { status: 'already_pending', request_id: REQUEST_ID },
        error: null,
      })

    const response = await POST(request({ action: 'join' }) as never)

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'requested',
      request_id: REQUEST_ID,
      already_pending: true,
    })
    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('retries membership once when visibility changes to open', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'approval_required' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'open_group' }, error: null })
      .mockResolvedValueOnce({
        data: { status: 'joined', owner_id: OWNER_ID, member_count: 8 },
        error: null,
      })

    const response = await POST(request({ action: 'join' }) as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(3)
    expect(mockRpc.mock.calls[2][0]).toBe('mutate_group_membership_atomic')
    expect(mockSendNotification).toHaveBeenCalledTimes(1)
  })

  it('fails closed on RPC errors, malformed results and failed gates', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
      .mockResolvedValueOnce({ data: { unexpected: true }, error: null })
      .mockResolvedValueOnce({ data: { status: 'banned' }, error: null })

    const dbFailure = await POST(request({ action: 'join' }) as never)
    const malformed = await POST(request({ action: 'join' }) as never)
    const banned = await POST(request({ action: 'join' }) as never)

    expect(dbFailure.status).toBe(500)
    expect(malformed.status).toBe(500)
    expect(banned.status).toBe(403)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 404],
    ['dissolved', 409],
    ['banned', 403],
    ['score_too_low', 403],
    ['verified_only', 403],
    ['premium_required', 403],
    ['invite_required', 403],
    ['owner_forbidden', 403],
    ['invalid', 400],
  ])('maps the %s database status to HTTP %i', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({
      data: { status, ...(status === 'score_too_low' ? { required_score: 75 } : {}) },
      error: null,
    })

    const response = await POST(request({ action: 'join' }) as never)

    expect(response.status).toBe(expectedStatus)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid_invite', 400],
    ['invite_already_used', 409],
  ])('maps invite redemption status %s to HTTP %i', async (status, expectedStatus) => {
    const inviteToken = generateInviteToken(GROUP_ID, Date.now() + 60_000)
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request({ action: 'join', invite_token: inviteToken }) as never)

    expect(response.status).toBe(expectedStatus)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('rejects malformed IDs, bodies and leave-only field smuggling', async () => {
    const invalidGroup = await POST(request({ action: 'join' }, 'not-a-uuid') as never)
    const invalidAction = await POST(request({ action: 'kick' }) as never)
    const extraField = await POST(request({ action: 'join', bypass_pro: true }) as never)
    const leaveSmuggling = await POST(
      request({ action: 'leave', invite_token: 'ignored' }) as never
    )

    expect(invalidGroup.status).toBe(400)
    expect(invalidAction.status).toBe(400)
    expect(extraField.status).toBe(400)
    expect(leaveSmuggling.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('group membership database ownership', () => {
  it('keeps membership and moderation routes free of direct membership writes and counters', () => {
    const routePaths = [
      'app/api/groups/[id]/membership/route.ts',
      'app/api/groups/[id]/members/[userId]/ban/route.ts',
      'app/api/groups/[id]/members/[userId]/kick/route.ts',
    ]

    for (const routePath of routePaths) {
      const source = readFileSync(join(process.cwd(), routePath), 'utf8')
      expect(source).not.toMatch(/\.from\(['"]group_members['"]\)/)
      expect(source).not.toMatch(/\.from\(['"]group_bans['"]\)/)
      expect(source).not.toMatch(/\bupdateCount\b/)
      expect(source).not.toContain('increment_member_count')
    }
  })
})
