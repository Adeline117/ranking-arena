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

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { json: () => Promise<unknown> }
      }) => unknown
    ) =>
    async (request: { json: () => Promise<unknown> }) =>
      handler({ user: { id: 'group-admin' }, request }),
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

const DB_ERROR = { code: 'XX001', message: 'database failed' }
const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const TARGET_ID = '20000000-0000-4000-8000-000000000002'

function request(body: unknown = { reason: 'abuse' }) {
  return { json: jest.fn().mockResolvedValue(body) }
}

function context() {
  return { params: Promise.resolve({ id: GROUP_ID, userId: TARGET_ID }) }
}

function resolveStatus(status: string) {
  mockRpc.mockResolvedValueOnce({ data: { status }, error: null })
}

describe('group member ban atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('calls the service-only RPC with server-authenticated actor identity', async () => {
    resolveStatus('banned')

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('moderate_group_member_atomic', {
      p_actor_id: 'group-admin',
      p_group_id: GROUP_ID,
      p_target_id: TARGET_ID,
      p_action: 'ban',
      p_reason: 'abuse',
    })
  })

  it('keeps repeated bans idempotent without inventing another audit event', async () => {
    resolveStatus('already_banned')

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, already_banned: true })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-string reason before invoking service authority', async () => {
    const response = await POST(request({ reason: { unexpected: true } }) as never, context())

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed route IDs before invoking service authority', async () => {
    const response = await POST(request() as never, {
      params: Promise.resolve({ id: 'not-a-uuid', userId: TARGET_ID }),
    })

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid_reason', 400],
    ['self_forbidden', 400],
    ['target_not_found', 404],
    ['not_found', 404],
    ['dissolved', 409],
    ['owner_forbidden', 403],
    ['hierarchy_forbidden', 403],
    ['forbidden', 403],
    ['account_inactive', 403],
  ])('maps atomic ban status %s to HTTP %i', async (status, expectedStatus) => {
    resolveStatus(status)

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed on RPC errors or malformed RPC data', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: DB_ERROR })
      .mockResolvedValueOnce({ data: [], error: null })

    const failed = await POST(request() as never, context())
    const malformed = await POST(request() as never, context())

    expect(failed.status).toBe(500)
    expect(malformed.status).toBe(500)
  })
})

describe('group member unban atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ['unbanned', { success: true }],
    ['already_unbanned', { success: true, already_unbanned: true }],
  ])('treats %s as an idempotent success', async (status, expectedBody) => {
    resolveStatus(status)

    const response = await DELETE(request() as never, context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expectedBody)
    expect(mockRpc).toHaveBeenCalledWith('moderate_group_member_atomic', {
      p_actor_id: 'group-admin',
      p_group_id: GROUP_ID,
      p_target_id: TARGET_ID,
      p_action: 'unban',
      p_reason: null,
    })
  })

  it.each([
    ['invalid', 400],
    ['not_found', 404],
    ['dissolved', 409],
    ['forbidden', 403],
    ['account_inactive', 403],
  ])('maps atomic unban status %s to HTTP %i', async (status, expectedStatus) => {
    resolveStatus(status)

    const response = await DELETE(request() as never, context())

    expect(response.status).toBe(expectedStatus)
  })

  it('fails closed when the unban RPC errors', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: DB_ERROR })

    const response = await DELETE(request() as never, context())

    expect(response.status).toBe(500)
  })
})
