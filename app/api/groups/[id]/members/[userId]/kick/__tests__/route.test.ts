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
  withAuth: (handler: (context: { user: { id: string } }) => unknown) => async () =>
    handler({ user: { id: 'group-admin' } }),
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

import { POST } from '../route'

const DB_ERROR = { code: 'XX001', message: 'database failed' }
const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const TARGET_ID = '20000000-0000-4000-8000-000000000002'

function request() {
  return {}
}

function context() {
  return { params: Promise.resolve({ id: GROUP_ID, userId: TARGET_ID }) }
}

function resolveStatus(status: string) {
  mockRpc.mockResolvedValueOnce({ data: { status }, error: null })
}

describe('POST group member kick atomic route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('notifies only after the atomic RPC reports a committed kick', async () => {
    resolveStatus('kicked')

    const response = await POST(request() as never, context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(mockRpc).toHaveBeenCalledWith('moderate_group_member_atomic', {
      p_actor_id: 'group-admin',
      p_group_id: GROUP_ID,
      p_target_id: TARGET_ID,
      p_action: 'kick',
      p_reason: null,
    })
    expect(mockSendNotification).toHaveBeenCalledWith(
      mockAdmin,
      expect.objectContaining({
        user_id: TARGET_ID,
        actor_id: 'group-admin',
        reference_id: GROUP_ID,
      }),
      'Kick notification'
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendNotification.mock.invocationCallOrder[0]
    )
  })

  it.each([
    ['self_forbidden', 400],
    ['invalid', 400],
    ['target_not_found', 404],
    ['not_member', 409],
    ['not_found', 404],
    ['dissolved', 409],
    ['owner_forbidden', 403],
    ['hierarchy_forbidden', 403],
    ['forbidden', 403],
    ['account_inactive', 403],
  ])('maps atomic kick status %s to HTTP %i without notifying', async (status, expectedStatus) => {
    resolveStatus(status)

    const response = await POST(request() as never, context())

    expect(response.status).toBe(expectedStatus)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('rejects malformed route IDs without invoking or notifying', async () => {
    const response = await POST(request() as never, {
      params: Promise.resolve({ id: GROUP_ID, userId: 'not-a-uuid' }),
    })

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('fails closed without notifying on RPC errors or malformed data', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: DB_ERROR })
      .mockResolvedValueOnce({ data: 'kicked', error: null })

    const failed = await POST(request() as never, context())
    const malformed = await POST(request() as never, context())

    expect(failed.status).toBe(500)
    expect(malformed.status).toBe(500)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})
