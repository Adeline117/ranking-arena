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
const mockAdmin = { rpc: mockRpc }
const mockGetSupabaseAdmin = jest.fn(() => mockAdmin)
const mockSendNotification = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: {
          json: () => Promise<unknown>
          headers: { get: (name: string) => string | null }
        }
      }) => unknown
    ) =>
    async (request: {
      json: () => Promise<unknown>
      headers: { get: (name: string) => string | null }
    }) =>
      handler({ user: { id: '10000000-0000-4000-8000-000000000001' }, request }),
}))
jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

import { DELETE, POST } from '../route'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const GROUP_ID = '20000000-0000-4000-8000-000000000002'
const TARGET_ID = '30000000-0000-4000-8000-000000000003'
const AUDIT_ID = '40000000-0000-4000-8000-000000000004'
const OPERATION_ID = '50000000-aaaa-4aaa-8aaa-000000000005'
const OTHER_OPERATION_ID = '60000000-bbbb-4bbb-8bbb-000000000006'
const NOW = Date.parse('2026-07-16T00:00:00.000Z')
const MUTED_UNTIL = '2026-07-16T03:00:00.000Z'

function request(
  body: unknown = { muted_until: MUTED_UNTIL, reason: '  spam  ' },
  idempotencyKey: string | null = OPERATION_ID
) {
  return {
    json: jest.fn().mockResolvedValue(body),
    headers: {
      get: jest.fn((name: string) =>
        name.toLowerCase() === 'idempotency-key' ? idempotencyKey : null
      ),
    },
  }
}

function context(groupId = GROUP_ID, targetUserId = TARGET_ID) {
  return { params: Promise.resolve({ id: groupId, userId: targetUserId }) }
}

function successResult(action: 'mute' | 'unmute', override: Record<string, unknown> = {}) {
  return {
    success: true,
    applied: true,
    action,
    operation_id: OPERATION_ID,
    group_id: GROUP_ID,
    target_id: TARGET_ID,
    group_name: 'Safety group',
    muted_until: action === 'mute' ? MUTED_UNTIL : null,
    mute_reason: action === 'mute' ? 'spam' : null,
    muted_by: action === 'mute' ? ACTOR_ID : null,
    audit_log_id: AUDIT_ID,
    ...override,
  }
}

describe('atomic group mute route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('commits through one service-only RPC, then sends only the system notification', async () => {
    mockRpc.mockResolvedValue({ data: successResult('mute'), error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      operation_id: OPERATION_ID,
    })
    expect(mockRpc).toHaveBeenCalledWith('moderate_group_mute_atomic', {
      p_actor_id: ACTOR_ID,
      p_operation_id: OPERATION_ID,
      p_group_id: GROUP_ID,
      p_target_id: TARGET_ID,
      p_action: 'mute',
      p_muted_until: MUTED_UNTIL,
      p_reason: 'spam',
    })
    expect(mockSendNotification).toHaveBeenCalledWith(
      mockAdmin,
      expect.objectContaining({
        user_id: TARGET_ID,
        type: 'system',
        title: 'Group mute notification',
        message: 'You have been muted in "Safety group" for 3 hours. \nReason: spam',
        actor_id: ACTOR_ID,
        reference_id: GROUP_ID,
        link: `/groups/${GROUP_ID}`,
      }),
      'group-mute'
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendNotification.mock.invocationCallOrder[0]
    )
    expect(mockAdmin).not.toHaveProperty('from')
  })

  it('keeps an exact retry idempotent without duplicating audit or notification', async () => {
    mockRpc.mockResolvedValue({
      data: successResult('mute', { applied: false, audit_log_id: null }),
      error: null,
    })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      operation_id: OPERATION_ID,
      already_muted: true,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('forwards an expired timestamp so a committed three-hour operation can still replay', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-16T04:00:00.000Z'))
    mockRpc.mockResolvedValue({
      data: successResult('mute', { applied: false, audit_log_id: null }),
      error: null,
    })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      operation_id: OPERATION_ID,
      already_muted: true,
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'moderate_group_mute_atomic',
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_muted_until: MUTED_UNTIL,
      })
    )
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('delegates a new operation timestamp validity decision to the database', async () => {
    const expiredTimestamp = '2026-07-15T23:59:59.000Z'
    mockRpc.mockResolvedValue({ data: null, error: { code: '22023' } })

    const response = await POST(
      request({ muted_until: expiredTimestamp, reason: 'spam' }) as never,
      context()
    )

    expect(response.status).toBe(400)
    expect(mockRpc).toHaveBeenCalledWith(
      'moderate_group_mute_atomic',
      expect.objectContaining({ p_muted_until: expiredTimestamp })
    )
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('normalizes uppercase IDs and accepts canonical future UUID versions', async () => {
    const groupId = '20000000-0000-7000-8000-000000000002'
    const targetId = '30000000-0000-8000-9000-000000000003'
    mockRpc.mockResolvedValue({
      data: successResult('mute', {
        group_id: groupId,
        target_id: targetId,
      }),
      error: null,
    })

    const response = await POST(
      request() as never,
      context(groupId.toUpperCase(), targetId.toUpperCase())
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'moderate_group_mute_atomic',
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_group_id: groupId,
        p_target_id: targetId,
      })
    )
  })

  it.each([
    ['missing', null],
    ['malformed', 'not-a-uuid'],
  ])('rejects a %s Idempotency-Key before invoking service authority', async (_label, key) => {
    const response = await POST(request(undefined, key) as never, context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid idempotency key' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed id', context('not-a-uuid')],
    ['malformed target id', context(GROUP_ID, 'not-a-uuid')],
  ])('rejects %s before invoking service authority', async (_label, routeContext) => {
    const response = await POST(request() as never, routeContext)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    [
      'invalid JSON',
      {
        ...request(),
        json: jest.fn().mockRejectedValue(new Error('bad json')),
      },
    ],
    ['missing timestamp', request({ reason: 'spam' })],
    ['malformed timestamp', request({ muted_until: 'not-a-timestamp' })],
    ['unknown field', request({ muted_until: MUTED_UNTIL, extra: true })],
    ['non-string reason', request({ muted_until: MUTED_UNTIL, reason: 42 })],
    ['oversized reason', request({ muted_until: MUTED_UNTIL, reason: 'x'.repeat(501) })],
  ])('rejects %s before the RPC', async (_label, invalidRequest) => {
    const response = await POST(invalidRequest as never, context())

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('counts astral Unicode reason characters like PostgreSQL char_length', async () => {
    const reason = '🧪'.repeat(500)
    mockRpc.mockResolvedValue({
      data: successResult('mute', { mute_reason: reason }),
      error: null,
    })

    const accepted = await POST(request({ muted_until: MUTED_UNTIL, reason }) as never, context())
    expect(accepted.status).toBe(200)
    expect(mockRpc).toHaveBeenLastCalledWith(
      'moderate_group_mute_atomic',
      expect.objectContaining({ p_reason: reason })
    )

    mockRpc.mockClear()
    const rejected = await POST(
      request({ muted_until: MUTED_UNTIL, reason: '🧪'.repeat(501) }) as never,
      context()
    )
    expect(rejected.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['ACTOR_UNAVAILABLE', 403],
    ['TARGET_UNAVAILABLE', 404],
    ['GROUP_NOT_FOUND', 404],
    ['GROUP_DISSOLVED', 409],
    ['ACTOR_NOT_MANAGER', 403],
    ['TARGET_NOT_MEMBER', 404],
    ['SELF_FORBIDDEN', 400],
    ['OWNER_FORBIDDEN', 403],
    ['HIERARCHY_FORBIDDEN', 403],
  ])('maps denial %s to HTTP %i without notifying', async (reason, status) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(status)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong operation', { operation_id: OTHER_OPERATION_ID }],
    ['malformed operation', { operation_id: 'not-a-uuid' }],
    ['missing operation', { operation_id: undefined }],
    ['wrong action', { action: 'unmute' }],
    ['wrong target', { target_id: ACTOR_ID }],
    ['wrong actor', { muted_by: TARGET_ID }],
    ['wrong timestamp', { muted_until: '2026-07-17T03:00:00.000Z' }],
    ['wrong reason', { mute_reason: 'different' }],
    ['missing audit evidence', { audit_log_id: null }],
    ['unexpected field', { unexpected: true }],
  ])('fails closed on an invalid acknowledgement: %s', async (_label, override) => {
    mockRpc.mockResolvedValue({ data: successResult('mute', override), error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['22023', 400],
    ['42501', 403],
    ['P0002', 404],
    ['40001', 409],
    ['40P01', 409],
    ['55P03', 409],
    ['XX000', 500],
  ])('maps database code %s to HTTP %i', async (code, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code } })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(status)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})

describe('atomic group unmute route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    [true, { success: true, operation_id: OPERATION_ID }, AUDIT_ID],
    [false, { success: true, operation_id: OPERATION_ID, already_unmuted: true }, null],
  ])(
    'returns an exact idempotent acknowledgement when applied=%s',
    async (applied, body, auditId) => {
      mockRpc.mockResolvedValue({
        data: successResult('unmute', { applied, audit_log_id: auditId }),
        error: null,
      })

      const response = await DELETE(request() as never, context())

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(body)
      expect(mockRpc).toHaveBeenCalledWith('moderate_group_mute_atomic', {
        p_actor_id: ACTOR_ID,
        p_operation_id: OPERATION_ID,
        p_group_id: GROUP_ID,
        p_target_id: TARGET_ID,
        p_action: 'unmute',
        p_muted_until: null,
        p_reason: null,
      })
      expect(mockSendNotification).not.toHaveBeenCalled()
    }
  )

  it('fails closed when an unmute acknowledgement retains moderation state', async () => {
    mockRpc.mockResolvedValue({
      data: successResult('unmute', { muted_by: ACTOR_ID }),
      error: null,
    })

    const response = await DELETE(request() as never, context())

    expect(response.status).toBe(500)
  })

  it.each([
    ['missing', null],
    ['malformed', 'not-a-uuid'],
  ])('rejects a %s Idempotency-Key before the unmute RPC', async (_label, key) => {
    const response = await DELETE(request(undefined, key) as never, context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid idempotency key' })
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
