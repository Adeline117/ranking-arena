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
const mockFrom = jest.fn()
const mockCreateUserScoped = jest.fn(() => ({ from: mockFrom }))
const mockSendNotification = jest.fn()
const mockLogError = jest.fn()
const mockAdmin = { rpc: (...args: unknown[]) => mockRpc(...args) }

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { url: string; headers: Headers; json: () => Promise<unknown> }
      }) => unknown
    ) =>
    async (request: { url: string; headers: Headers; json: () => Promise<unknown> }) =>
      handler({
        user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
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
jest.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => mockAdmin }))
jest.mock('@/lib/supabase/user-scoped-server', () => ({
  createUserScopedServerClient: (...args: unknown[]) => mockCreateUserScoped(...args),
}))

import { POST } from '../route'

const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const REQUEST_ID = '30000000-0000-4000-8000-000000000003'
const APPLICANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function request(body: unknown, groupId = GROUP_ID, requestId = REQUEST_ID) {
  return {
    url: `http://localhost/api/groups/${groupId}/join-requests/${requestId}/review`,
    headers: new Headers({ authorization: 'Bearer owner-jwt' }),
    json: jest.fn().mockResolvedValue(body),
  }
}

function bindingQuery(data: unknown, error: unknown = null) {
  const result = { data, error }
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return chain
}

describe('atomic join-request review route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateUserScoped.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue(
      bindingQuery({ id: REQUEST_ID, group_id: GROUP_ID, user_id: APPLICANT_ID })
    )
  })

  it.each([
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const)('commits %s through the atomic RPC before notifying', async (decision, status) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request({ decision }) as never)

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('group_join_requests')
    expect(mockRpc).toHaveBeenCalledWith('review_group_join_request_atomic', {
      p_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      p_request_id: REQUEST_ID,
      p_decision: decision,
    })
    expect(mockSendNotification).toHaveBeenCalledWith(
      mockAdmin,
      expect.objectContaining({
        user_id: APPLICANT_ID,
        actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        reference_id: GROUP_ID,
      }),
      expect.any(String)
    )
  })

  it('binds the immutable request identity to the nested group URL under RLS', async () => {
    const query = bindingQuery(null)
    mockFrom.mockReturnValue(query)

    const response = await POST(request({ decision: 'approve' }) as never)

    expect(response.status).toBe(404)
    expect(query.eq).toHaveBeenCalledWith('id', REQUEST_ID)
    expect(query.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('fails closed when the caller-scoped binding read fails', async () => {
    mockFrom.mockReturnValue(bindingQuery(null, { message: 'read failed' }))

    const response = await POST(request({ decision: 'approve' }) as never)

    expect(response.status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('makes repeated matching decisions idempotent without duplicate notifications', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'already_approved' }, error: null })
      .mockResolvedValueOnce({
        data: { status: 'already_processed', request_status: 'rejected' },
        error: null,
      })

    const approved = await POST(request({ decision: 'approve' }) as never)
    const rejected = await POST(request({ decision: 'reject' }) as never)

    await expect(approved.json()).resolves.toEqual({
      success: true,
      decision: 'approved',
      already_approved: true,
    })
    await expect(rejected.json()).resolves.toEqual({
      success: true,
      decision: 'rejected',
      already_processed: true,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns conflict when a concurrent terminal state contradicts the decision', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'already_processed', request_status: 'cancelled' },
      error: null,
    })

    const response = await POST(request({ decision: 'approve' }) as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'Join request was already processed',
      request_status: 'cancelled',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('reconciles an applicant who joined concurrently without another notification', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_member' }, error: null })

    const response = await POST(request({ decision: 'approve' }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      decision: 'reconciled',
      already_member: true,
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['request_not_found', 404],
    ['target_not_found', 404],
    ['not_found', 404],
    ['account_inactive', 403],
    ['forbidden', 403],
    ['dissolved', 409],
    ['target_inactive', 409],
    ['target_banned', 409],
    ['invalid', 400],
    ['unknown_status', 500],
  ])('maps final database status %s to HTTP %i', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request({ decision: 'approve' }) as never)

    expect(response.status).toBe(expectedStatus)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('rejects malformed IDs and decision bodies before any read or write', async () => {
    expect((await POST(request({ decision: 'approve' }, 'bad-id') as never)).status).toBe(400)
    expect((await POST(request({ decision: 'maybe' }) as never)).status).toBe(400)
    expect((await POST(request({ decision: 'approve', admin: true }) as never)).status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps review writes inside the atomic RPC', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/groups/[id]/join-requests/[requestId]/review/route.ts'),
      'utf8'
    )
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.update(')
    expect(source).not.toContain('.delete(')
    expect(source).toContain('createUserScopedServerClient(request)')
    expect(source).toContain("'review_group_join_request_atomic'")
  })
})
