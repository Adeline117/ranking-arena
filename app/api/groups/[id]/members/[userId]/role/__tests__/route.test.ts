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
const mockFrom = jest.fn(() => {
  throw new Error('role route must not access tables directly')
})
const mockAdmin = { rpc: mockRpc, from: mockFrom }
const mockGetSupabaseAdmin = jest.fn(() => mockAdmin)

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { json: () => Promise<unknown> }
      }) => unknown
    ) =>
    async (request: { json: () => Promise<unknown> }) =>
      handler({ user: { id: '10000000-0000-4000-8000-000000000001' }, request }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

import { POST } from '../route'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const GROUP_ID = '20000000-0000-4000-8000-000000000002'
const TARGET_ID = '30000000-0000-4000-8000-000000000003'
const AUDIT_ID = '40000000-0000-4000-8000-000000000004'
const OTHER_ID = '50000000-0000-4000-8000-000000000005'

function request(body: unknown = { role: 'admin' }) {
  return { json: jest.fn().mockResolvedValue(body) }
}

function context(groupId = GROUP_ID, targetUserId = TARGET_ID) {
  return { params: Promise.resolve({ id: groupId, userId: targetUserId }) }
}

function successAcknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    audit_id: AUDIT_ID,
    changed: true,
    group_id: GROUP_ID,
    previous_role: 'member',
    role: 'admin',
    target_id: TARGET_ID,
    ...overrides,
  }
}

describe('POST group member role atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('changes a role through exactly one service-only RPC and no table access', async () => {
    mockRpc.mockResolvedValue({ data: successAcknowledgement(), error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, role: 'admin' })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('set_group_member_role_atomic', {
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_target_id: TARGET_ID,
      p_role: 'admin',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('accepts an exact idempotent acknowledgement without inventing an audit', async () => {
    mockRpc.mockResolvedValue({
      data: successAcknowledgement({
        audit_id: null,
        changed: false,
        previous_role: 'admin',
      }),
      error: null,
    })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, role: 'admin' })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('normalizes uppercase route IDs before calling and binding the authority', async () => {
    mockRpc.mockResolvedValue({
      data: successAcknowledgement({
        group_id: GROUP_ID.toUpperCase(),
        target_id: TARGET_ID.toUpperCase(),
      }),
      error: null,
    })

    const response = await POST(
      request() as never,
      context(GROUP_ID.toUpperCase(), TARGET_ID.toUpperCase())
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'set_group_member_role_atomic',
      expect.objectContaining({ p_group_id: GROUP_ID, p_target_id: TARGET_ID })
    )
  })

  it.each([
    ['group ID', context('not-a-uuid', TARGET_ID)],
    ['target ID', context(GROUP_ID, 'not-a-uuid')],
  ])('rejects an invalid %s before obtaining service authority', async (_label, routeContext) => {
    const response = await POST(request() as never, routeContext)

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects self-role changes before obtaining service authority', async () => {
    const response = await POST(request() as never, context(GROUP_ID, ACTOR_ID))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Cannot change your own role' })
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['missing role', request({})],
    ['unknown role', request({ role: 'owner' })],
    ['non-string role', request({ role: 1 })],
    ['extra field', request({ role: 'admin', target: OTHER_ID })],
    ['array body', request([{ role: 'admin' }])],
    ['null body', request(null)],
  ])('rejects an invalid body with %s before the RPC', async (_label, invalidRequest) => {
    const response = await POST(invalidRequest as never, context())

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before the RPC', async () => {
    const invalidRequest = {
      json: jest.fn().mockRejectedValue(new SyntaxError('bad json')),
    }

    const response = await POST(invalidRequest as never, context())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400],
    ['ACTOR_UNAVAILABLE', 403],
    ['TARGET_UNAVAILABLE', 404],
    ['GROUP_NOT_FOUND', 404],
    ['GROUP_DISSOLVED', 409],
    ['PERMISSION_DENIED', 403],
    ['TARGET_NOT_MEMBER', 404],
    ['OWNER_FORBIDDEN', 400],
  ])('maps exact atomic denial %s to HTTP %i', async (reason, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['22023', 400],
    ['42501', 403],
    ['40001', 409],
    ['40P01', 409],
    ['55P03', 409],
    ['XX001', 500],
  ])('maps database error %s to HTTP %i', async (code, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'failed' } })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['array', []],
    ['scalar', 'success'],
    ['unknown denial', { success: false, reason: 'SOMETHING_ELSE' }],
    ['denial with extra data', { success: false, reason: 'INVALID', extra: true }],
    ['missing success field', { reason: 'INVALID' }],
    ['success with extra data', successAcknowledgement({ extra: true })],
    ['bad actor ID', successAcknowledgement({ actor_id: 'bad' })],
    ['bad group ID', successAcknowledgement({ group_id: 'bad' })],
    ['bad target ID', successAcknowledgement({ target_id: 'bad' })],
    ['bad audit ID', successAcknowledgement({ audit_id: 'bad' })],
    ['bad previous role', successAcknowledgement({ previous_role: 'owner' })],
    ['bad applied role', successAcknowledgement({ role: 'owner' })],
    ['changed without audit', successAcknowledgement({ audit_id: null })],
    ['changed without transition', successAcknowledgement({ previous_role: 'admin' })],
    ['unchanged with audit', successAcknowledgement({ changed: false, previous_role: 'admin' })],
    [
      'unchanged across different roles',
      successAcknowledgement({ changed: false, audit_id: null }),
    ],
  ])('fails closed on malformed acknowledgement: %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request() as never, context())

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['actor', { actor_id: OTHER_ID }],
    ['group', { group_id: OTHER_ID }],
    ['target', { target_id: OTHER_ID }],
    [
      'role',
      {
        previous_role: 'admin',
        role: 'member',
      },
    ],
  ])(
    'fails closed when the acknowledgement contradicts the requested %s',
    async (_label, override) => {
      mockRpc.mockResolvedValue({ data: successAcknowledgement(override), error: null })

      const response = await POST(request() as never, context())

      expect(response.status).toBe(500)
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )
})
