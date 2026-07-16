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
const mockLogError = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        request: { url: string; headers: Headers }
      }) => unknown
    ) =>
    async (request: { url: string; headers: Headers }) =>
      handler({
        user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        request,
      }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLogError(...args) },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))
jest.mock('@/lib/supabase/user-scoped-server', () => ({
  createUserScopedServerClient: (...args: unknown[]) => mockCreateUserScoped(...args),
}))
jest.mock('@/lib/types/premium', () => ({ PRO_FREE_PROMO: true }))

import { DELETE, GET } from '../route'

const GROUP_ID = '10000000-0000-4000-8000-000000000001'
const REQUEST_ID = '30000000-0000-4000-8000-000000000003'

function request(suffix = '', groupId = GROUP_ID) {
  return {
    url: `http://localhost/api/groups/${groupId}/join-requests${suffix}`,
    headers: new Headers({ authorization: 'Bearer user-jwt' }),
  }
}

function listQuery(data: unknown, error: unknown = null) {
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn().mockResolvedValue({ data, error }),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  chain.in.mockReturnValue(chain)
  chain.order.mockReturnValue(chain)
  return chain
}

describe('group join-request list and cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateUserScoped.mockReturnValue({ from: mockFrom })
  })

  it('lists pending requests through the caller-scoped RLS client', async () => {
    const rows = [{ id: REQUEST_ID, group_id: GROUP_ID, status: 'pending' }]
    const query = listQuery(rows)
    mockFrom.mockReturnValue(query)

    const response = await GET(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, requests: rows })
    expect(mockCreateUserScoped).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('group_join_requests')
    expect(query.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
    expect(query.eq).toHaveBeenCalledWith('status', 'pending')
    expect(query.limit).toHaveBeenCalledWith(100)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('supports a bounded active filter without bypassing RLS', async () => {
    const query = listQuery([])
    mockFrom.mockReturnValue(query)

    const response = await GET(request('?status=active') as never)

    expect(response.status).toBe(200)
    expect(query.in).toHaveBeenCalledWith('status', ['pending', 'approved'])
    expect(mockCreateUserScoped).toHaveBeenCalledTimes(1)
  })

  it('fails closed on RLS query and client construction failures', async () => {
    mockFrom.mockReturnValueOnce(listQuery(null, { message: 'query failed' }))
    const queryFailure = await GET(request() as never)

    mockCreateUserScoped.mockImplementationOnce(() => {
      throw new Error('missing anon key')
    })
    const clientFailure = await GET(request() as never)

    expect(queryFailure.status).toBe(500)
    expect(clientFailure.status).toBe(500)
    expect(mockLogError).toHaveBeenCalled()
  })

  it('cancels through the actor-owned atomic RPC', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'cancelled', request_id: REQUEST_ID },
      error: null,
    })

    const response = await DELETE(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      action: 'cancelled',
      request_id: REQUEST_ID,
    })
    expect(mockRpc).toHaveBeenCalledWith('mutate_group_join_request_atomic', {
      p_actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      p_group_id: GROUP_ID,
      p_action: 'cancel',
      p_answer_text: null,
      p_pro_free_promo: true,
    })
    expect(mockCreateUserScoped).not.toHaveBeenCalled()
  })

  it('makes repeated cancellation idempotent', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'no_request' }, error: null })

    const response = await DELETE(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, action: 'no_request' })
  })

  it('fails closed on cancellation errors and malformed success evidence', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: 'db down' } })
      .mockResolvedValueOnce({ data: { status: 'cancelled' }, error: null })

    expect((await DELETE(request() as never)).status).toBe(500)
    expect((await DELETE(request() as never)).status).toBe(500)
  })

  it('rejects malformed group IDs and list filters before touching data', async () => {
    expect((await GET(request('', 'not-a-uuid') as never)).status).toBe(400)
    expect((await GET(request('?status=joined') as never)).status).toBe(400)
    expect((await DELETE(request('', 'not-a-uuid') as never)).status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps the list path read-only and the cancel path RPC-owned', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/groups/[id]/join-requests/route.ts'),
      'utf8'
    )
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.update(')
    expect(source).not.toMatch(/\.from\(['"]group_join_requests['"]\)\s*\.delete/)
    expect(source).toContain('createUserScopedServerClient(request)')
    expect(source).toContain("'mutate_group_join_request_atomic'")
  })
})
